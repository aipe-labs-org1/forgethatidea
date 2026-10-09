import { describe, expect, it, vi } from 'vitest';
import { runGenerationPipeline, isGenerationFailure } from './generation-pipeline.js';
import type { GenerationSpec } from './generation-spec.js';
import type { AnthropicMessageParam } from './anthropic-client.js';

function spec(): GenerationSpec {
  return {
    archetype: 'crud-tracker',
    productName: 'HabitLoop',
    icp: 'people building daily habits',
    entities: [{ name: 'Habit', fields: [{ name: 'title', type: 'string' }] }],
    screens: [{ name: 'Habit list', purpose: 'see all habits' }],
    roles: ['user'],
    keyActions: ['create habit'],
    branding: { accentColor: '#2E7D32', tone: 'encouraging' },
  };
}

function scriptedClient(text: string, opts: { inputTokens?: number; outputTokens?: number } = {}) {
  return {
    streamMessage: vi.fn(async (_req: unknown, handlers: { onText?: (t: string) => void }) => {
      handlers.onText?.(text);
      return {
        inputTokens: opts.inputTokens ?? 100,
        outputTokens: opts.outputTokens ?? 200,
        stopReason: 'end_turn',
        content: [{ type: 'text' as const, text }],
      };
    }),
  };
}

describe('runGenerationPipeline (#65)', () => {
  it('produces a candidate artifact from a successful model call', async () => {
    const code = 'export default function App() { return null; }';
    const client = scriptedClient(code);

    const result = await runGenerationPipeline({ spec: spec(), anthropicClient: client });

    expect(isGenerationFailure(result)).toBe(false);
    if (!isGenerationFailure(result)) {
      expect(result.code).toBe(code);
    }
  });

  it('reports token usage and cost for the build', async () => {
    const client = scriptedClient('export default function App() { return null; }', {
      inputTokens: 500,
      outputTokens: 1000,
    });

    const result = await runGenerationPipeline({ spec: spec(), anthropicClient: client });

    expect(isGenerationFailure(result)).toBe(false);
    if (!isGenerationFailure(result)) {
      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBe(1000);
      expect(result.costCents).toBeGreaterThan(0);
    }
  });

  it('streams progress via onProgress as text arrives', async () => {
    const client = scriptedClient('export default function App() { return null; }');
    const onProgress = vi.fn();

    await runGenerationPipeline({ spec: spec(), anthropicClient: client, onProgress });

    expect(onProgress).toHaveBeenCalled();
  });

  it('reports a model_error failure when the client throws, without letting it propagate', async () => {
    const client = { streamMessage: vi.fn(async () => Promise.reject(new Error('api down'))) };

    const result = await runGenerationPipeline({ spec: spec(), anthropicClient: client });

    expect(isGenerationFailure(result)).toBe(true);
    if (isGenerationFailure(result)) {
      expect(result.error).toBe('model_error');
    }
  });

  it('reports a timeout failure when the model call exceeds the configured timeout', async () => {
    const client = {
      streamMessage: vi.fn(
        () =>
          new Promise<{
            inputTokens: number;
            outputTokens: number;
            stopReason: string;
            content: never[];
          }>(() => {}), // never resolves
      ),
    };

    const result = await runGenerationPipeline({
      spec: spec(),
      anthropicClient: client,
      timeoutMs: 20,
    });

    expect(isGenerationFailure(result)).toBe(true);
    if (isGenerationFailure(result)) {
      expect(result.error).toBe('timeout');
    }
  });

  it('reports empty_response when the model returns no text content', async () => {
    const client = {
      streamMessage: vi.fn(async () => ({
        inputTokens: 10,
        outputTokens: 0,
        stopReason: 'end_turn',
        content: [],
      })),
    };

    const result = await runGenerationPipeline({ spec: spec(), anthropicClient: client });

    expect(isGenerationFailure(result)).toBe(true);
    if (isGenerationFailure(result)) {
      expect(result.error).toBe('empty_response');
    }
  });

  it('includes the prior code and exact validation errors in the prompt when repairing (#67)', async () => {
    const client = scriptedClient('export default function App() { return null; }');

    await runGenerationPipeline({
      spec: spec(),
      anthropicClient: client,
      repairContext: {
        previousCode: 'export default function App() { return <div>',
        errors: ['compile_error', 'forbidden_localStorage'],
      },
    });

    const req = client.streamMessage.mock.calls[0]![0] as { messages: AnthropicMessageParam[] };
    const sentPrompt = req.messages[0]!.content;
    expect(sentPrompt).toContain('export default function App() { return <div>');
    expect(sentPrompt).toContain('compile_error');
    expect(sentPrompt).toContain('forbidden_localStorage');
  });
});

describe('generation timeout default (production e2e finding)', () => {
  it('allows a full app generation to finish but stays inside the 300s function limit', async () => {
    const { DEFAULT_GENERATION_TIMEOUT_MS } = await import('./generation-pipeline.js');
    expect(DEFAULT_GENERATION_TIMEOUT_MS).toBeGreaterThanOrEqual(240_000);
    expect(DEFAULT_GENERATION_TIMEOUT_MS).toBeLessThan(300_000);
  });
});
