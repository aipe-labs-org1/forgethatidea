import type { MessageContentBlock, StreamMessageRequest } from './anthropic-client.js';
import { buildCodegenPrompt } from './codegen-contract.js';
import { ARCHETYPES } from './archetype-catalog.js';
import { DEFAULT_PRICING, normalizeUsage } from './model-router.js';
import type { GenerationSpec } from './generation-spec.js';

export interface GenerationAnthropicClient {
  streamMessage(
    request: StreamMessageRequest,
    handlers: { onText?: (text: string) => void },
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    stopReason: string;
    /**
     * Widened to MessageContentBlock (rather than AssistantContentBlock) so
     * this interface can be satisfied by the same real anthropic client the
     * agent orchestrator (#34) uses (OrchestratorAnthropicClient) without a
     * type mismatch — this pipeline never sends tools, so a tool_result
     * block is never actually produced, but the client's declared type
     * still needs to allow for it structurally.
     */
    content: MessageContentBlock[];
  }>;
}

export interface RepairContext {
  /** The previously generated code that failed validation. */
  previousCode: string;
  /** The exact validation error codes it failed on (#66's ValidationFailure.errors). */
  errors: string[];
}

export interface GenerationPipelineInput {
  spec: GenerationSpec;
  anthropicClient: GenerationAnthropicClient;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Called with each chunk of generated text as it streams in, for progress UI. */
  onProgress?: (text: string) => void;
  /** When set, this call is a repair attempt (#67) — the prompt includes the prior code and exact errors instead of starting fresh. */
  repairContext?: RepairContext;
}

export interface GenerationSuccess {
  ok: true;
  code: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface GenerationFailure {
  ok: false;
  error: 'model_error' | 'timeout' | 'empty_response';
}

export type GenerationResult = GenerationSuccess | GenerationFailure;

/**
 * Explicit type guard rather than relying on inline `!result.ok` narrowing —
 * this pattern has caused a Vercel-only build failure multiple times this
 * project even when local tsc is clean on the same TypeScript version.
 */
export function isGenerationFailure(result: GenerationResult): result is GenerationFailure {
  return result.ok === false;
}

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 8192;
// A full app generation (up to 8192 output tokens) took longer than 120s in
// production and failed every build; 240s leaves headroom under Vercel's
// 300s function limit for the rest of the build request.
export const DEFAULT_GENERATION_TIMEOUT_MS = 240_000;

/**
 * Wraps the base generation prompt with the exact validation errors (#66)
 * and the prior candidate's code (Epic 4.6) — including real error codes
 * rather than a generic "try again" gives the model something concrete to
 * fix, and the prior code lets it make a targeted edit instead of guessing
 * what it wrote before.
 */
function buildRepairPrompt(basePrompt: string, repair: RepairContext): string {
  return `${basePrompt}

The previous attempt failed validation with these exact errors:
${repair.errors.map((e) => `- ${e}`).join('\n')}

Previous attempt:
\`\`\`
${repair.previousCode}
\`\`\`

Fix every error listed above and produce a corrected, complete replacement for the entire file — not a diff or partial snippet.`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('generation_timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Generation pipeline (Epic 4.4): the server-side step invoking the model
 * with the compiled generation spec (#64) via the codegen prompt/contract
 * (#63), streaming progress, and producing the candidate app file (a plain
 * string of source code — validation, Epic 4.5, and auto-repair, Epic 4.6,
 * happen as separate steps downstream of this).
 *
 * "No dead-end states": every failure mode (model error, timeout, an
 * unexpectedly empty response) resolves to a typed `GenerationFailure`
 * rather than a thrown exception, matching the orchestrator's guardrail
 * pattern (#40) — a build request should never crash the request, only
 * report a specific, actionable reason.
 */
export async function runGenerationPipeline(
  input: GenerationPipelineInput,
): Promise<GenerationResult> {
  const { spec, anthropicClient } = input;
  const model = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;

  const basePrompt = buildCodegenPrompt({
    manifest: specToPromptManifest(spec),
    archetype: ARCHETYPES[spec.archetype],
  });
  const prompt = input.repairContext
    ? buildRepairPrompt(basePrompt, input.repairContext)
    : basePrompt;

  let result;
  try {
    result = await withTimeout(
      anthropicClient.streamMessage(
        { model, maxTokens, messages: [{ role: 'user', content: prompt }] },
        { onText: input.onProgress },
      ),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'generation_timeout') {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: 'model_error' };
  }

  const code = result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  if (!code.trim()) {
    return { ok: false, error: 'empty_response' };
  }

  const costCents = normalizeUsage(DEFAULT_PRICING, 'anthropic', model, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    stopReason: null,
  }).costCents;

  return {
    ok: true,
    code,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costCents,
  };
}

/**
 * `buildCodegenPrompt` takes the full `{manifest, archetype}` shape (#63,
 * predates the spec compiler); a `GenerationSpec` already carries everything
 * it needs, just without the two fields the prompt builder never reads
 * (`schemaVersion`, `references`) — this adapts one to the other rather than
 * changing buildCodegenPrompt's signature and touching every existing call
 * site.
 */
function specToPromptManifest(spec: GenerationSpec) {
  return {
    schemaVersion: 1 as const,
    productName: spec.productName,
    icp: spec.icp,
    entities: spec.entities,
    screens: spec.screens,
    roles: spec.roles,
    keyActions: spec.keyActions,
    branding: spec.branding,
    references: { researchCardIds: [] },
    archetype: spec.archetype,
  };
}
