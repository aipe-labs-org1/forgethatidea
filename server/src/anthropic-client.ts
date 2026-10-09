import { Anthropic } from '@anthropic-ai/sdk';

export interface MessageStreamEvent {
  type: string;
  index?: number;
  /** `text_delta` carries `text`; `input_json_delta` (a tool_use block's streamed arguments — never read directly here, see anthropic-client.ts's module doc) carries `partial_json`. */
  delta?: { type: string; text?: string; partial_json?: string };
  content_block?: { type: string; id?: string; name?: string; input?: unknown };
}

/** One resolved content block from the SDK's own finalMessage() — the authoritative, fully-accumulated shape (unlike the raw streamed events, a tool_use block here always has its complete input). */
type FinalMessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown };

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

/** A message's assistant-produced content — what `content` blocks look like when a model responds. */
export type AssistantContentBlock = TextBlock | ToolUseBlock;

/** A message's content when sent *to* the model — plain text, or tool_use/tool_result for multi-turn tool calling. */
export type MessageContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  /** Plain text is shorthand for a single text block — richer turns (tool_use/tool_result) need the array form. */
  content: string | MessageContentBlock[];
}

/** A tool definition offered to the model, in this codebase's naming convention (camelCase inputSchema). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface StreamMessageRequest {
  model: string;
  maxTokens: number;
  system?: string;
  messages: AnthropicMessageParam[];
  /** Tools the model may call this turn — omit for a plain text-only turn. */
  tools?: ToolDefinition[];
  /**
   * Thinking depth (output_config.effort). Claude Opus 5 thinks adaptively by
   * default and thinking tokens count against maxTokens — lower effort leaves
   * more of the budget for the actual answer. Omit for the model default.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface StreamMessageHandlers {
  onText?: (text: string) => void;
  onToolUse?: (block: ToolUseBlock) => void;
}

export interface StreamMessageResult {
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  /**
   * The assistant's full content blocks (text + tool_use, in order) — what
   * the caller appends as the next turn's assistant message when continuing
   * a multi-turn tool-calling conversation. Not just the aggregate text,
   * since a tool_use block carries no text of its own to reconstruct from.
   */
  content: AssistantContentBlock[];
}

export interface Logger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/** Anthropic SDK's own snake_case tool shape — converted to/from this codebase's ToolDefinition at the boundary. */
interface SdkToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
}

/** Minimal slice of the Anthropic SDK client this wrapper depends on. */
export interface AnthropicSdkClient {
  messages: {
    stream: (params: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: AnthropicMessageParam[];
      tools?: SdkToolDefinition[];
      output_config?: { effort: NonNullable<StreamMessageRequest['effort']> };
    }) => AsyncIterable<MessageStreamEvent> & {
      finalMessage: () => Promise<{
        id: string;
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
        content: FinalMessageContentBlock[];
      }>;
    };
  };
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

export interface AnthropicClientDeps {
  sdkClient: AnthropicSdkClient;
  logger: Logger;
  retry?: RetryConfig;
}

const DEFAULT_RETRY: RetryConfig = { maxRetries: 2, baseDelayMs: 500 };

/** HTTP statuses the Anthropic API returns for transient failures — safe to retry with backoff. */
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 529]);

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Server-side wrapper around the Anthropic Messages API (Epic 0.9). Streams
 * text and tool_use blocks to the caller, retries transient failures with
 * exponential backoff, and logs token usage per request.
 */
export function createAnthropicClient(deps: AnthropicClientDeps) {
  const { sdkClient, logger } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;

  async function streamMessage(
    request: StreamMessageRequest,
    handlers: StreamMessageHandlers,
  ): Promise<StreamMessageResult> {
    let attempt = 0;
    for (;;) {
      try {
        const stream = sdkClient.messages.stream({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: request.messages,
          tools: request.tools?.map(
            (tool): SdkToolDefinition => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            }),
          ),
          ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        });

        // Only text is accumulated from raw streamed events (for onText's
        // live incremental callback) — a tool_use block's real arguments
        // are NOT available at content_block_start (the API always starts
        // it with an empty input; the actual JSON streams in afterward as
        // input_json_delta events on the same index) and this code never
        // accumulated those deltas. That was a real production bug: every
        // tool call's arguments were silently discarded, so every tool
        // always received `{}` regardless of what the model actually sent.
        // The SDK's own finalMessage() already does this accumulation
        // correctly, so resolved tool_use content (and its real input) is
        // sourced from there instead of rebuilt by hand.
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            handlers.onText?.(event.delta.text ?? '');
          } else if (
            event.type === 'content_block_start' &&
            event.content_block?.type === 'tool_use'
          ) {
            const block = event.content_block;
            // Fired as an early "a tool call is starting" signal only —
            // its input is always empty at this point and must never be
            // trusted as complete (see above). Real-time consumers that
            // need the resolved input should read result.content instead.
            handlers.onToolUse?.({
              type: 'tool_use',
              id: block.id ?? '',
              name: block.name ?? '',
              input: block.input,
            });
          }
        }

        const final = await stream.finalMessage();
        const content: AssistantContentBlock[] = final.content
          .filter(
            (block): block is Extract<FinalMessageContentBlock, { type: 'text' | 'tool_use' }> =>
              block.type === 'text' || block.type === 'tool_use',
          )
          .map(
            (block): AssistantContentBlock =>
              block.type === 'tool_use'
                ? { type: 'tool_use', id: block.id, name: block.name, input: block.input }
                : { type: 'text', text: block.text },
          );
        logger.info(
          {
            messageId: final.id,
            model: request.model,
            inputTokens: final.usage.input_tokens,
            outputTokens: final.usage.output_tokens,
            stopReason: final.stop_reason,
          },
          'anthropic message completed',
        );
        return {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
          stopReason: final.stop_reason,
          content,
        };
      } catch (err) {
        if (isRetryable(err) && attempt < retry.maxRetries) {
          const delay = retry.baseDelayMs * 2 ** attempt;
          logger.warn(
            { attempt, delay, error: err instanceof Error ? err.message : String(err) },
            'retrying transient anthropic api failure',
          );
          attempt++;
          await sleep(delay);
          continue;
        }
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'anthropic api request failed',
        );
        throw err;
      }
    }
  }

  return { streamMessage };
}

/** Builds the real Anthropic SDK client from the server's API key. */
export function createSdkClient(apiKey: string): AnthropicSdkClient {
  return new Anthropic({ apiKey }) as unknown as AnthropicSdkClient;
}
