import { describe, it, expect, vi } from 'vitest';
import { createAnthropicClient, type MessageStreamEvent } from './anthropic-client.js';

/**
 * Builds a fake SDK client whose `messages.stream` yields the given raw
 * events, and whose `finalMessage()` resolves with `finalContent` — the
 * SDK's own fully-accumulated content blocks (real tool_use input included).
 * Defaults `finalContent` to `[]` only for tests that don't care about it.
 */
function fakeSdkClient(
  events: MessageStreamEvent[],
  usage = { input_tokens: 10, output_tokens: 5 },
  finalContent: unknown[] = [],
) {
  return {
    messages: {
      stream: vi.fn(() => {
        async function* iterate() {
          for (const event of events) yield event;
        }
        return {
          [Symbol.asyncIterator]: iterate,
          finalMessage: async () => ({
            id: 'msg_1',
            stop_reason: 'end_turn',
            usage,
            content: finalContent,
          }),
        };
      }),
    },
  };
}

describe('createAnthropicClient', () => {
  it('streams text deltas to the provided handler', async () => {
    const sdk = fakeSdkClient([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    ]);
    const client = createAnthropicClient({ sdkClient: sdk as never, logger: silentLogger() });

    const chunks: string[] = [];
    await client.streamMessage(
      { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { onText: (t) => chunks.push(t) },
    );

    expect(chunks.join('')).toBe('Hello');
  });

  it('surfaces tool_use blocks to the dispatcher via onToolUse', async () => {
    // The real API always starts a tool_use block with an empty input —
    // the actual arguments stream in afterward as input_json_delta events
    // (see the "streams a tool call's real arguments" test below) and are
    // only fully assembled by the SDK's own finalMessage(). onToolUse fires
    // at content_block_start purely as an early "a tool call is starting"
    // signal; its input is not meant to be trusted as complete.
    const sdk = fakeSdkClient([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      },
    ]);
    const client = createAnthropicClient({ sdkClient: sdk as never, logger: silentLogger() });

    const toolUses: unknown[] = [];
    await client.streamMessage(
      { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { onToolUse: (block) => toolUses.push(block) },
    );

    expect(toolUses).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }]);
  });

  it('resolves tool_use blocks in the result with their real, fully-streamed input from finalMessage — not the empty input from content_block_start (#manifest-bug)', async () => {
    // Regression test for a real production bug: tool_use arguments stream
    // in as input_json_delta events *after* content_block_start (which
    // always has an empty input) — the previous implementation built its
    // result content from raw streamed events and never accumulated those
    // deltas, so every tool call's real arguments were silently discarded
    // and every tool always received `{}`. The SDK's own finalMessage()
    // already does this accumulation correctly; the fix is to source
    // resolved content from there instead of from hand-rolled event state.
    const sdk = fakeSdkClient(
      [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'update_manifest', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"patch":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"productName":"HabitLoop"}}' },
        },
      ],
      undefined,
      [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'update_manifest',
          input: { patch: { productName: 'HabitLoop' } },
        },
      ],
    );
    const client = createAnthropicClient({ sdkClient: sdk as never, logger: silentLogger() });

    const result = await client.streamMessage(
      { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      {},
    );

    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'update_manifest',
        input: { patch: { productName: 'HabitLoop' } },
      },
    ]);
  });

  it('logs token usage per request', async () => {
    const sdk = fakeSdkClient([], { input_tokens: 42, output_tokens: 7 });
    const logger = silentLogger();
    const client = createAnthropicClient({ sdkClient: sdk as never, logger });

    await client.streamMessage(
      { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      {},
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 42, outputTokens: 7 }),
      expect.any(String),
    );
  });

  it('resolves with usage and stop reason for the caller', async () => {
    const sdk = fakeSdkClient([], { input_tokens: 42, output_tokens: 7 });
    const client = createAnthropicClient({ sdkClient: sdk as never, logger: silentLogger() });

    const result = await client.streamMessage(
      { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      {},
    );

    expect(result).toEqual({
      inputTokens: 42,
      outputTokens: 7,
      stopReason: 'end_turn',
      content: [],
    });
  });

  it('passes tool definitions through to the SDK call', async () => {
    const sdk = fakeSdkClient([]);
    const client = createAnthropicClient({ sdkClient: sdk as never, logger: silentLogger() });
    const tools = [
      { name: 'get_weather', description: 'Get the weather', inputSchema: { type: 'object' } },
    ];

    await client.streamMessage(
      {
        model: 'claude-opus-5',
        maxTokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        tools,
      },
      {},
    );

    expect(sdk.messages.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          { name: 'get_weather', description: 'Get the weather', input_schema: { type: 'object' } },
        ],
      }),
    );
  });

  it('accepts rich content blocks (tool_use/tool_result) in message history, not just plain strings', async () => {
    const sdk = fakeSdkClient([]);
    const client = createAnthropicClient({ sdkClient: sdk as never, logger: silentLogger() });

    await client.streamMessage(
      {
        model: 'claude-opus-5',
        maxTokens: 100,
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false },
            ],
          },
        ],
      },
      {},
    );

    expect(sdk.messages.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false },
            ],
          },
        ],
      }),
    );
  });

  it('collects assistant content blocks (text + tool_use) into the result for building the next turn', async () => {
    const sdk = fakeSdkClient(
      [
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Checking...' },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
        },
      ],
      undefined,
      // result.content is now sourced entirely from finalMessage() (see
      // anthropic-client.ts's module doc) — onText's live callback still
      // reads text deltas as they stream, but the resolved content array
      // itself, text included, comes from the SDK's own accumulation.
      [
        { type: 'text', text: 'Checking...' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
      ],
    );
    const client = createAnthropicClient({ sdkClient: sdk as never, logger: silentLogger() });

    const result = await client.streamMessage(
      { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      {},
    );

    expect(result.content).toEqual([
      { type: 'text', text: 'Checking...' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
    ]);
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    let attempts = 0;
    const sdk = {
      messages: {
        stream: vi.fn(() => {
          attempts++;
          if (attempts < 3) {
            const err = new Error('overloaded') as Error & { status: number };
            err.status = 529;
            throw err;
          }
          async function* iterate() {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ok' },
            };
          }
          return {
            [Symbol.asyncIterator]: iterate,
            finalMessage: async () => ({
              id: 'msg_1',
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [],
            }),
          };
        }),
      },
    };
    const client = createAnthropicClient({
      sdkClient: sdk as never,
      logger: silentLogger(),
      retry: { maxRetries: 3, baseDelayMs: 0 },
    });

    const chunks: string[] = [];
    await client.streamMessage(
      { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { onText: (t) => chunks.push(t) },
    );

    expect(attempts).toBe(3);
    expect(chunks.join('')).toBe('ok');
  });

  it('does not retry non-retryable errors', async () => {
    const sdk = {
      messages: {
        stream: vi.fn(() => {
          const err = new Error('bad request') as Error & { status: number };
          err.status = 400;
          throw err;
        }),
      },
    };
    const client = createAnthropicClient({
      sdkClient: sdk as never,
      logger: silentLogger(),
      retry: { maxRetries: 3, baseDelayMs: 0 },
    });

    await expect(
      client.streamMessage(
        { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
        {},
      ),
    ).rejects.toThrow('bad request');
    expect(sdk.messages.stream).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries on persistent transient failures', async () => {
    const sdk = {
      messages: {
        stream: vi.fn(() => {
          const err = new Error('overloaded') as Error & { status: number };
          err.status = 529;
          throw err;
        }),
      },
    };
    const client = createAnthropicClient({
      sdkClient: sdk as never,
      logger: silentLogger(),
      retry: { maxRetries: 2, baseDelayMs: 0 },
    });

    await expect(
      client.streamMessage(
        { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
        {},
      ),
    ).rejects.toThrow('overloaded');
    expect(sdk.messages.stream).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});

function silentLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
}

describe('effort control', () => {
  it('sends output_config.effort when an effort is requested', async () => {
    const sdk = fakeSdkClient([]);
    const client = createAnthropicClient({ sdkClient: sdk as never, logger: silentLogger() });
    await client.streamMessage(
      {
        model: 'claude-opus-5',
        maxTokens: 100,
        effort: 'low',
        messages: [{ role: 'user', content: 'hi' }],
      },
      {},
    );
    expect(sdk.messages.stream).toHaveBeenCalledWith(
      expect.objectContaining({ output_config: { effort: 'low' } }),
    );
  });

  it('omits output_config when no effort is requested', async () => {
    const sdk = fakeSdkClient([]);
    const client = createAnthropicClient({ sdkClient: sdk as never, logger: silentLogger() });
    await client.streamMessage(
      { model: 'claude-opus-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      {},
    );
    const params = (sdk.messages.stream.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('output_config');
  });
});
