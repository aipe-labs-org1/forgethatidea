import type { MessageContentBlock, StreamMessageRequest } from './anthropic-client.js';
import {
  validateGeneratedCode,
  isValidationFailure,
  compileForPreview,
} from './generation-validation.js';

export interface DiffEditRetryContext {
  previousAttempt: string;
  errors: string[];
}

/**
 * Composes the targeted-edit prompt (Epic 4.15): asks the model to apply
 * one specific change request to the existing working code, rather than
 * regenerating from scratch — "visual stability: unrelated parts unchanged"
 * per the issue. Still requires a complete replacement file as output (not
 * a unified-diff format), matching the codegen contract's (#63) single-file
 * output requirement; the "targeted" instruction is about what the model
 * changes, not the shape of what it returns.
 */
export function buildDiffEditPrompt(
  currentCode: string,
  changeRequest: string,
  retry?: DiffEditRetryContext,
  intentContext?: string,
): string {
  const intentLine = intentContext ? `\n\nParsed intent: ${intentContext}` : '';

  const base = `
Apply this change request to the existing app below with a targeted edit — change only what the request asks for, and leave everything unrelated exactly as it is (unrelated markup, styling, state, and logic must stay visually and behaviorally identical).

Change request: ${changeRequest}${intentLine}

Current app:
\`\`\`
${currentCode}
\`\`\`

Respond with the complete, corrected file — not a diff, not a snippet — so the whole app can be replaced with your output directly.
`.trim();

  if (!retry) {
    return base;
  }

  return `${base}

The previous edit attempt failed validation with these exact errors:
${retry.errors.map((e) => `- ${e}`).join('\n')}

Previous attempt:
\`\`\`
${retry.previousAttempt}
\`\`\`

Fix every error listed above while still applying the original change request and leaving unrelated parts unchanged.`;
}

export interface DiffEditAnthropicClient {
  streamMessage(
    request: StreamMessageRequest,
    handlers: { onText?: (text: string) => void },
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    stopReason: string;
    content: MessageContentBlock[];
  }>;
}

export interface RunDiffEditInput {
  currentCode: string;
  changeRequest: string;
  anthropicClient: DiffEditAnthropicClient;
  model?: string;
  maxTokens?: number;
  /** Max retry rounds after the initial edit attempt before reverting to the original code. */
  maxRepairRounds?: number;
  /** Optional parsed target/action hint (Epic 5.5's request parser) appended alongside the raw change request — never in place of it. */
  intentContext?: string;
}

export interface DiffEditSuccess {
  ok: true;
  code: string;
  /** Pre-transpiled plain JS for `code` (see generation-validation.ts) — lets the preview iframe run with no client-side eval. */
  compiledCode: string;
  /** True when every edit attempt failed validation and the original code was kept unchanged, rather than an unrelated regeneration. */
  revertedToOriginal: boolean;
  repairRounds: number;
}

export interface DiffEditFailure {
  ok: false;
  error: 'model_error' | 'edit_failed';
}

export type DiffEditResult = DiffEditSuccess | DiffEditFailure;

/**
 * Explicit type guard rather than relying on inline `!result.ok` narrowing —
 * this pattern has caused a Vercel-only build failure multiple times this
 * project even when local tsc is clean on the same TypeScript version.
 */
export function isDiffEditFailure(result: DiffEditResult): result is DiffEditFailure {
  return result.ok === false;
}

const DEFAULT_MODEL = 'claude-opus-5';
// Same budget as app generation (generation-pipeline.ts): the edit returns
// the whole file, and Claude Opus 5's default thinking counts against it.
const DEFAULT_MAX_TOKENS = 32_000;
const DEFAULT_MAX_REPAIR_ROUNDS = 2;

/**
 * Refinement diff-edit pipeline (Epic 4.15): applies a user's change request
 * as a targeted edit to the existing artifact rather than a full
 * regeneration, keeping refinements fast, cheap, and visually stable.
 * On a failed edit, retries with the exact validation errors fed back
 * (same shape as #67's auto-repair loop) — still pursuing the same change
 * request — and only once those retries are exhausted does it fall back,
 * reverting to the original unedited code rather than regenerating an
 * unrelated app the user never asked for. A model-call failure ends the
 * loop immediately with `model_error` rather than burning repair rounds on
 * a problem retries can't fix.
 */
export async function runDiffEdit(input: RunDiffEditInput): Promise<DiffEditResult> {
  const { currentCode, changeRequest, anthropicClient, intentContext } = input;
  const model = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxRepairRounds = input.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;

  let retry: DiffEditRetryContext | undefined;

  for (let round = 0; round <= maxRepairRounds; round++) {
    const prompt = buildDiffEditPrompt(currentCode, changeRequest, retry, intentContext);

    let result;
    try {
      result = await anthropicClient.streamMessage(
        { model, maxTokens, effort: 'low', messages: [{ role: 'user', content: prompt }] },
        {},
      );
    } catch {
      return { ok: false, error: 'model_error' };
    }

    const editedCode = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const validation = await validateGeneratedCode(editedCode);
    if (!isValidationFailure(validation)) {
      return {
        ok: true,
        code: editedCode,
        compiledCode: validation.compiledCode,
        revertedToOriginal: false,
        repairRounds: round,
      };
    }

    if (round === maxRepairRounds) {
      return {
        ok: true,
        code: currentCode,
        compiledCode: await compileForPreview(currentCode),
        revertedToOriginal: true,
        repairRounds: round,
      };
    }

    retry = { previousAttempt: editedCode, errors: validation.errors };
  }

  // Unreachable — the loop always returns within its bounds — but keeps the
  // function's return type total rather than relying on control-flow
  // analysis across the for loop.
  return {
    ok: true,
    code: currentCode,
    compiledCode: await compileForPreview(currentCode),
    revertedToOriginal: true,
    repairRounds: maxRepairRounds,
  };
}
