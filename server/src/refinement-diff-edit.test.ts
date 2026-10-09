import { describe, it, expect, vi } from 'vitest';
import { buildDiffEditPrompt, runDiffEdit, isDiffEditFailure } from './refinement-diff-edit.js';

// Includes a minimal real error boundary (componentDidCatch) — required by
// the missing_error_boundary contract rule (#80) for code to count as valid,
// since the revert-to-original path (below) compiles this for preview too.
const CURRENT_CODE = `class ErrorBoundary extends React.Component {
  componentDidCatch(error) {}
  render() { return this.props.children; }
}
export default function App() {
  const [habits, setHabits] = React.useState([]);
  return <div>{habits.length}</div>;
}`;
// Includes a minimal real error boundary (componentDidCatch) — required by
// the missing_error_boundary contract rule (#80) for code to count as valid.
const VALID_EDITED_CODE = `class ErrorBoundary extends React.Component {
  componentDidCatch(error) {}
  render() { return this.props.children; }
}
export default function App() {
  const [habits, setHabits] = React.useState([]);
  return <div>Habits: {habits.length}</div>;
}`;
const INVALID_EDIT = 'localStorage.setItem("x", "1"); function App() { return null; }';

describe('buildDiffEditPrompt (#76)', () => {
  it('includes the current code and the change request', () => {
    const prompt = buildDiffEditPrompt(CURRENT_CODE, 'Add a label before the count.');
    expect(prompt).toContain(CURRENT_CODE);
    expect(prompt).toContain('Add a label before the count.');
  });

  it('instructs a targeted edit, not a full rewrite', () => {
    const prompt = buildDiffEditPrompt(CURRENT_CODE, 'Add a label.');
    expect(prompt.toLowerCase()).toContain('targeted');
    expect(prompt.toLowerCase()).toContain('unrelated');
  });

  it('requires a complete replacement file as output, not a diff format', () => {
    const prompt = buildDiffEditPrompt(CURRENT_CODE, 'Add a label.');
    expect(prompt.toLowerCase()).toContain('complete');
  });

  it('includes the exact prior validation errors when retrying after a failed attempt', () => {
    const prompt = buildDiffEditPrompt(CURRENT_CODE, 'Add a label.', {
      previousAttempt: INVALID_EDIT,
      errors: ['forbidden_localStorage'],
    });
    expect(prompt).toContain('forbidden_localStorage');
    expect(prompt).toContain(INVALID_EDIT);
  });
});

describe('runDiffEdit (#76)', () => {
  it('applies a valid targeted edit and returns the new code on the first attempt', async () => {
    const client = {
      streamMessage: vi.fn(async (_req: unknown, handlers: { onText?: (t: string) => void }) => {
        handlers.onText?.(VALID_EDITED_CODE);
        return {
          inputTokens: 10,
          outputTokens: 20,
          stopReason: 'end_turn',
          content: [{ type: 'text' as const, text: VALID_EDITED_CODE }],
        };
      }),
    };

    const result = await runDiffEdit({
      currentCode: CURRENT_CODE,
      changeRequest: 'Add a label before the count.',
      anthropicClient: client,
    });

    expect(isDiffEditFailure(result)).toBe(false);
    if (!isDiffEditFailure(result)) {
      expect(result.code).toBe(VALID_EDITED_CODE);
      expect(result.revertedToOriginal).toBe(false);
      expect(result.repairRounds).toBe(0);
      expect(result.compiledCode).toContain('ForgeCompiledApp');
    }
    expect(client.streamMessage).toHaveBeenCalledTimes(1);
  });

  it('retries the edit with validation errors fed back when the first attempt fails', async () => {
    let call = 0;
    const client = {
      streamMessage: vi.fn(async (_req: unknown, handlers: { onText?: (t: string) => void }) => {
        call++;
        const text = call === 1 ? INVALID_EDIT : VALID_EDITED_CODE;
        handlers.onText?.(text);
        return {
          inputTokens: 10,
          outputTokens: 20,
          stopReason: 'end_turn',
          content: [{ type: 'text' as const, text }],
        };
      }),
    };

    const result = await runDiffEdit({
      currentCode: CURRENT_CODE,
      changeRequest: 'Add a label.',
      anthropicClient: client,
    });

    expect(isDiffEditFailure(result)).toBe(false);
    if (!isDiffEditFailure(result)) {
      expect(result.code).toBe(VALID_EDITED_CODE);
      expect(result.revertedToOriginal).toBe(false);
      expect(result.repairRounds).toBe(1);
    }
    expect(client.streamMessage).toHaveBeenCalledTimes(2);

    const secondCallPrompt = (
      client.streamMessage.mock.calls[1]![0] as { messages: { content: string }[] }
    ).messages[0]!.content;
    expect(secondCallPrompt).toContain('forbidden_localStorage');
  });

  it('reverts to the original unedited code once retries are exhausted, never inventing an unrelated app', async () => {
    const client = {
      streamMessage: vi.fn(async (_req: unknown, handlers: { onText?: (t: string) => void }) => {
        handlers.onText?.(INVALID_EDIT);
        return {
          inputTokens: 10,
          outputTokens: 20,
          stopReason: 'end_turn',
          content: [{ type: 'text' as const, text: INVALID_EDIT }],
        };
      }),
    };

    const result = await runDiffEdit({
      currentCode: CURRENT_CODE,
      changeRequest: 'Add a label.',
      anthropicClient: client,
      maxRepairRounds: 1,
    });

    expect(isDiffEditFailure(result)).toBe(false);
    if (!isDiffEditFailure(result)) {
      expect(result.code).toBe(CURRENT_CODE);
      expect(result.revertedToOriginal).toBe(true);
      expect(result.compiledCode).toContain('ForgeCompiledApp');
    }
    // Initial attempt + 1 repair round = 2 total calls.
    expect(client.streamMessage).toHaveBeenCalledTimes(2);
  });

  it('never throws when the model call fails — resolves to a typed failure', async () => {
    const client = { streamMessage: vi.fn(async () => Promise.reject(new Error('down'))) };

    const result = await runDiffEdit({
      currentCode: CURRENT_CODE,
      changeRequest: 'Add a label.',
      anthropicClient: client,
    });

    expect(isDiffEditFailure(result)).toBe(true);
    if (isDiffEditFailure(result)) {
      expect(result.error).toBe('model_error');
    }
  });
});

describe('diff-edit output budget (production e2e finding)', () => {
  it('asks for low effort and a large output budget for the full-file rewrite', async () => {
    const client = {
      streamMessage: vi.fn(async () => ({
        inputTokens: 10,
        outputTokens: 20,
        stopReason: 'end_turn',
        content: [{ type: 'text' as const, text: VALID_EDITED_CODE }],
      })),
    };
    await runDiffEdit({
      currentCode: CURRENT_CODE,
      changeRequest: 'Add a label.',
      anthropicClient: client,
    });
    const request = (client.streamMessage.mock.calls[0] as unknown[])[0] as {
      maxTokens: number;
      effort?: string;
    };
    expect(request.effort).toBe('low');
    expect(request.maxTokens).toBeGreaterThanOrEqual(32_000);
  });
});
