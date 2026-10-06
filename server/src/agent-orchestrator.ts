import { randomUUID } from 'node:crypto';
import type {
  AnthropicMessageParam,
  MessageContentBlock,
  StreamMessageRequest,
} from './anthropic-client.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createToolDispatcher, type ToolRegistry, type Logger } from './tool-dispatch.js';
import { createManifestTools } from './manifest-tools.js';
import { createSourcesTools } from './sources-tools.js';
import { createPhaseTransitionTool } from './phase-transition-tool.js';
import { createManifestSummaryTool } from './manifest-summary-tool.js';
import { createRenderBuildOptionsTool } from './render-build-options-tool.js';
import { createRenderArchitectureTool } from './render-architecture-tool.js';
import { createRenderCostTableTool } from './render-cost-table-tool.js';
import { createRenderMarketingPlansTool } from './render-marketing-plans-tool.js';
import { createMarketingRefinementTool } from './marketing-refinement.js';
import type { RefinementLimits } from './refinement-tracker.js';
import { compactChatHistory } from './conversation-compaction.js';
import { emitAnalyticsEvent, type AnalyticsLogger } from './analytics.js';
import type { TurnEvent } from './turn-events.js';
import type { SessionStore } from './session-store.js';
import type { ManifestStore } from './manifest-store.js';
import type { createCostGuard } from './cost-guard.js';
import { CostCapExceededError } from './cost-guard.js';
import { DEFAULT_PRICING, normalizeUsage } from './model-router.js';
import type { ChatMessage } from './chat-message.js';
import type { AgentModule, ModuleToolSchema } from './agents/module-types.js';
import { assembleActiveModules } from './agents/module-registry.js';
import { ADVISOR_MODULES } from './agents/advisor-roster.js';
import type { TierProduct } from './tier-catalog.js';

export interface OrchestratorAnthropicClient {
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

export interface AgentOrchestratorDeps {
  sessionStore: SessionStore;
  manifestStore: ManifestStore;
  costGuard: ReturnType<typeof createCostGuard>;
  anthropicClient: OrchestratorAnthropicClient;
  /** Model used for the agent loop — defaults to the same model the task registry routes agent-loop to. */
  model?: string;
  maxTokens?: number;
  /** Extra tools beyond the built-in manifest tools (e.g. web_search) — merged in, manifest tools always win on name clash. */
  extraTools?: ToolRegistry;
  /** Max tool-call round-trips per turn before giving up rather than looping forever on a confused model. */
  maxToolRounds?: number;
  /** Free-tier refinement round ceilings (Epic 2.11) — defaults match env.ts's FREE_APP/MARKETING_REFINEMENT_LIMIT default of 3. Only `marketing` is consulted here (refine_marketing_plans, #88); `app` refinement goes through refine-app-orchestrator.ts's own route, not this orchestrator. */
  refinementLimits?: RefinementLimits;
  /** Messages kept verbatim before older ones are compacted into a summary (#37) — see DEFAULT_KEEP_RECENT_MESSAGES. */
  keepRecentMessages?: number;
  /** Session analytics sink (#42) — defaults to a no-op so it's opt-in until build-app.ts wires the real logger. */
  analyticsLogger?: AnalyticsLogger;
  /**
   * Diagnostic logger for tool call dispatch — every tool call is logged at
   * info level (or warn, for a tool's own domain-level failure result), so
   * a rejection like update_manifest's `no_manifest_to_merge_into` is
   * visible in logs instead of only surfacing as a vague user complaint
   * much later with no diagnostic trail. Defaults to silent so tests don't
   * need to pass one; build-app.ts wires the real Fastify logger.
   */
  logger?: Logger;
  /**
   * Activity agents (docs/build-agents.md) that join the turn alongside the
   * spine phase tools — every active one contributes its own prompt block
   * and tools to the same single model call. Defaults to the full advisor
   * roster.
   */
  modules?: AgentModule[];
  /** Paid-tier check for gated agents (entitlements service, #100). Absent means paid agents always refuse. */
  hasEntitlement?: (userId: string, tierId: string) => Promise<boolean>;
  /** Paid tier names/prices (#97), shown on paywall cards when a paid agent is refused. */
  tierCatalog?: TierProduct[];
}

export interface HandleTurnSuccess {
  ok: true;
  reply: string;
  /**
   * Phase/card events that occurred during this turn, in the exact order
   * they happened — "ordering guaranteed" per #39. Empty when nothing
   * changed. The client updates the phase rail / renders cards by walking
   * this list in order, rather than needing a separate streaming
   * connection (see turn-events.ts for why).
   */
  events: TurnEvent[];
}

export interface HandleTurnFailure {
  ok: false;
  error: 'session_not_found' | 'cost_cap_exceeded';
  reason?: string;
}

export type HandleTurnResult = HandleTurnSuccess | HandleTurnFailure;

/**
 * Explicit type guard rather than relying on inline `!result.ok` narrowing
 * of the union — a prior PR (#38's refinement-tracker.ts) hit a Vercel-only
 * build failure where that inline narrowing didn't hold in Vercel's
 * (separately-invoked, non-Turbo-cached) tsc pass even though it typechecked
 * fine locally. This sidesteps the whole class of issue.
 */
export function isHandleTurnFailure(result: HandleTurnResult): result is HandleTurnFailure {
  return result.ok === false;
}

const DEFAULT_MODEL = 'claude-opus-5';
// Agent cards (render_launch, render_pitch_deck, …) carry several prose
// sections in one tool call; at 2048 the call was cut off mid-JSON in
// production and arrived with only `summary`.
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_TOOL_ROUNDS = 5;
/** Matches env.ts's FREE_APP_REFINEMENT_LIMIT/FREE_MARKETING_REFINEMENT_LIMIT default. */
const DEFAULT_REFINEMENT_LIMITS: RefinementLimits = { app: 3, marketing: 3 };
/**
 * How many of the most recent chat messages stay verbatim before older ones
 * are collapsed into one compaction summary (#37) — keeps both the model
 * call's context and the persisted session row bounded regardless of how
 * long a session runs. The manifest, not chat, is authoritative, so this is
 * free to be lossy about conversational color as long as it stays coherent.
 */
const DEFAULT_KEEP_RECENT_MESSAGES = 30;
/** Consecutive rounds where every tool call in the round errored, before giving up on this turn as "off track". */
const MAX_CONSECUTIVE_FAILED_ROUNDS = 2;

/**
 * Reminder injected before the last tool round (Epic 2.13 follow-up): a
 * production incident showed the model can make several rounds of genuinely
 * successful tool calls (get_manifest, update_manifest, ...) without ever
 * emitting a text reply, silently burning the whole maxToolRounds budget and
 * leaving the user staring at the generic fallback with no real answer. This
 * is appended as an extra text block alongside the final round's tool
 * results, giving the model one explicit chance to wrap up in text before
 * the budget runs out, rather than finding out only after the fact.
 */
const WRAP_UP_NUDGE =
  "[system reminder: this is your final tool round for this turn — stop calling tools now and respond to the user in plain text with what you've learned or done so far.]";

/**
 * Agent error recovery & guardrails (Epic 2.13): the single fallback shown
 * whenever the turn can't reach a real reply — a model API failure, or the
 * agent stuck repeatedly failing the same tool call. Always the same
 * message so it's recognizable and testable, and always `ok: true` (never a
 * thrown error or a dead end) so the user is never blocked mid-conversation.
 */
const BACK_ON_TRACK_FALLBACK =
  "I ran into trouble finishing that — let's try a different approach. Could you rephrase what you'd like?";

const BUILT_IN_TOOL_SCHEMAS = {
  get_manifest: {
    description: 'Read the current build manifest for this session, if one exists yet.',
    inputSchema: { type: 'object', properties: {} },
  },
  update_manifest: {
    description:
      "Apply an update to the build manifest. IMPORTANT: if no manifest exists yet for this session (check with get_manifest first), your patch must be a COMPLETE manifest in one call — productName, icp, at least one entity (with at least one field each), at least one screen, at least one role, at least one key action, and branding (accentColor as a 6-digit hex, plus tone). A partial/single-field patch will be rejected when there's nothing yet to merge it into. Once a manifest exists, later calls may send just the fields you're changing — those genuinely merge into what's there.",
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'object' } },
      required: ['patch'],
    },
  },
  record_source: {
    description:
      'Record one competitor name, app, or reference link the user mentions during the sources phase.',
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
  },
  decline_sources: {
    description:
      'Record that the user has explicitly said they have no competitor/reference sources to share.',
    inputSchema: { type: 'object', properties: {} },
  },
  transition_phase: {
    description:
      'Advance the session to the next phase once its work is genuinely done. Only a single forward step is ever legal, and later phases (e.g. build) require their gate conditions to already be satisfied.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' } },
      required: ['to'],
    },
  },
  summarize_manifest: {
    description:
      'Recap the current build manifest in plain, non-technical language — the idea, entities, screens, key actions, and whether cost/marketing work has started. Use this whenever the user asks what has been decided so far.',
    inputSchema: { type: 'object', properties: {} },
  },
  render_build_options: {
    description:
      'Present exactly 3 meaningfully different build-direction options to the user during the brainstorm/planning phase (differing in scope, audience, or core mechanic — not just wording). Each option needs a short name and a one-sentence summary. Calling this again replaces the previous set of options rather than adding to it.',
    inputSchema: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              summary: { type: 'string' },
            },
            required: ['name', 'summary'],
          },
        },
      },
      required: ['options'],
    },
  },
  select_build_option: {
    description:
      "Lock in the user's chosen build option once they've picked one from the presented options (0-based index). This finalizes the options card so planning can proceed.",
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number' } },
      required: ['index'],
    },
  },
  render_architecture: {
    description:
      "Present a plain-language system architecture (boxes and arrows) for the chosen build direction — components and how they connect, described the way you'd explain it to a non-technical founder. Never use technical jargon (API, database, backend, server, etc.) in the summary, component names, or descriptions — describe what each piece IS and DOES for the user in plain terms instead. Calling this again replaces the previous architecture rather than adding to it.",
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        components: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['name', 'description'],
          },
        },
        connections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['from', 'to', 'label'],
          },
        },
      },
      required: ['summary', 'components', 'connections'],
    },
  },
  lock_architecture: {
    description: 'Lock in the current architecture once the user is happy with it.',
    inputSchema: { type: 'object', properties: {} },
  },
  render_cost_table: {
    description:
      'Present line-item monthly cost estimates as a table, at one or more usage scales (e.g. "100 users" and "1,000 users") so the user can see how costs grow. Every line item MUST have a real assumption and a real sourceUrl — call get_pricing_tiers first to ground these in actual published pricing rather than inventing numbers. Never fabricate a price or a source; this is a hard non-negotiable honesty rule. Calling this again replaces the previous cost table rather than adding to it.',
    inputSchema: {
      type: 'object',
      properties: {
        scales: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              lineItems: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    monthlyCostCents: { type: 'number' },
                    assumption: { type: 'string' },
                    sourceUrl: { type: 'string' },
                  },
                  required: ['name', 'monthlyCostCents', 'assumption', 'sourceUrl'],
                },
              },
            },
            required: ['label', 'lineItems'],
          },
        },
      },
      required: ['scales'],
    },
  },
  lock_cost_table: {
    description: 'Lock in the current cost table once the user is happy with it.',
    inputSchema: { type: 'object', properties: {} },
  },
  web_search: {
    description:
      'Search the live web for real competitors, prices, regulations and sources. Use it to ground any factual claim before citing it.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
    },
  },
  get_pricing_tiers: {
    description:
      'Look up real, published pricing tiers (hosting, database, ai, domain, or email) to ground render_cost_table line items in actual sourced figures instead of invented ones. Omit category to get every tier.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['hosting', 'database', 'ai', 'domain', 'email'],
        },
      },
    },
  },
  render_marketing_plans: {
    description:
      'Present exactly 3 marketing plan directions, each covering the ideal customer profile (icp), go-to-market approach (gtm), SEO angle, and ads angle. Each plan must name at least one real competitor it positions against — use web_search first to find and confirm real competitors rather than inventing names. Calling this again replaces the previous set of plans rather than adding to it.',
    inputSchema: {
      type: 'object',
      properties: {
        plans: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              icp: { type: 'string' },
              gtm: { type: 'string' },
              seo: { type: 'string' },
              ads: { type: 'string' },
              competitors: { type: 'array', items: { type: 'string' }, minItems: 1 },
            },
            required: ['name', 'icp', 'gtm', 'seo', 'ads', 'competitors'],
          },
        },
      },
      required: ['plans'],
    },
  },
  select_marketing_plan: {
    description:
      "Lock in the user's chosen marketing plan once they've picked one from the presented plans (0-based index).",
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number' } },
      required: ['index'],
    },
  },
  refine_marketing_plans: {
    description:
      'Update the marketing plan after it has already been locked once, in response to a user change request during the refine phase (e.g. "change the ads angle" or "target a different ICP"). Present the SAME 3-plan structure as render_marketing_plans (icp/gtm/seo/ads/competitors for all 3 plans, not just the one the user asked to change), with your requested edits applied — this replaces the whole set and re-locks it. Each free-tier session has a limited number of these refinement rounds; if the limit is reached, tell the user plainly rather than calling this again. During planning (before the first lock), use render_marketing_plans instead — this tool is only for post-lock refinement.',
    inputSchema: {
      type: 'object',
      properties: {
        plans: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              icp: { type: 'string' },
              gtm: { type: 'string' },
              seo: { type: 'string' },
              ads: { type: 'string' },
              competitors: { type: 'array', items: { type: 'string' }, minItems: 1 },
            },
            required: ['name', 'icp', 'gtm', 'seo', 'ads', 'competitors'],
          },
        },
      },
      required: ['plans'],
    },
  },
} as const;

function toAnthropicMessages(chat: ChatMessage[]): AnthropicMessageParam[] {
  return chat.map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text }));
}

/**
 * The agent orchestrator (Epic 2, the piece #34/#35/#39/#40/#43 all depend
 * on): ties the system prompt (#30), tool dispatcher (#31), manifest tools
 * (#33), and cost guardrails (#0.11) into one real conversational turn.
 *
 * One call to `handleTurn` = one full round: check the cost guard, build the
 * system prompt from the session's current phase, send the conversation
 * history + the new user message to the model with tools available, dispatch
 * any tool_use blocks the model asks for, feed the results back and let the
 * model continue (up to `maxToolRounds` round-trips) until it produces a
 * final text reply, then persist the user message + reply to session chat
 * and record the turn's cost.
 */
export function createAgentOrchestrator(deps: AgentOrchestratorDeps) {
  const { sessionStore, manifestStore, costGuard, anthropicClient } = deps;
  const model = deps.model ?? DEFAULT_MODEL;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxToolRounds = deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const refinementLimits = deps.refinementLimits ?? DEFAULT_REFINEMENT_LIMITS;
  const keepRecentMessages = deps.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
  const analyticsLogger = deps.analyticsLogger ?? { info: () => {} };
  const logger = deps.logger ?? silentLogger();
  const modules = deps.modules ?? ADVISOR_MODULES;

  async function handleTurn(
    sessionId: string,
    userId: string,
    userMessage: string,
  ): Promise<HandleTurnResult> {
    const session = await sessionStore.get(sessionId);
    if (!session) {
      return { ok: false, error: 'session_not_found' };
    }

    try {
      await costGuard.checkBeforeCall({ sessionId, userId });
    } catch (err) {
      if (err instanceof CostCapExceededError) {
        return { ok: false, error: 'cost_cap_exceeded', reason: err.reason };
      }
      throw err;
    }

    const events: TurnEvent[] = [];
    const manifestTools = createManifestTools({ store: manifestStore, sessionId });
    const sourcesTools = createSourcesTools({ store: sessionStore, sessionId });
    const phaseTransitionTool = createPhaseTransitionTool({
      store: sessionStore,
      manifestStore,
      sessionId,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'phase_changed') {
          emitAnalyticsEvent(analyticsLogger, {
            type: 'phase_entered',
            sessionId,
            phase: event.to,
          });
          // Reaching `build` means the manifest/cost/marketing gate (#29) is
          // satisfied — the funnel's real "conversion" milestone today, ahead
          // of any billing/entitlement concept (not yet built).
          if (event.to === 'build') {
            emitAnalyticsEvent(analyticsLogger, { type: 'session_converted', sessionId });
          }
        }
      },
    });
    const manifestSummaryTool = createManifestSummaryTool({
      sessionStore,
      manifestStore,
      sessionId,
    });
    const buildOptionsTool = createRenderBuildOptionsTool({
      store: sessionStore,
      sessionId,
      onEvent: (event) => events.push(event),
    });
    const architectureTool = createRenderArchitectureTool({
      store: sessionStore,
      sessionId,
      onEvent: (event) => events.push(event),
    });
    const costTableTool = createRenderCostTableTool({
      store: sessionStore,
      sessionId,
      onEvent: (event) => events.push(event),
    });
    const marketingPlansTool = createRenderMarketingPlansTool({
      store: sessionStore,
      sessionId,
      onEvent: (event) => events.push(event),
    });
    const marketingRefinementTool = createMarketingRefinementTool({
      store: sessionStore,
      sessionId,
      renderMarketingPlans: marketingPlansTool.render_marketing_plans,
      limits: refinementLimits,
    });
    const toolRegistry: ToolRegistry = {
      get_manifest: manifestTools.get_manifest,
      update_manifest: manifestTools.update_manifest,
      record_source: sourcesTools.record_source,
      decline_sources: sourcesTools.decline_sources,
      transition_phase: phaseTransitionTool.transition_phase,
      summarize_manifest: manifestSummaryTool.summarize_manifest,
      render_build_options: buildOptionsTool.render_build_options,
      select_build_option: buildOptionsTool.select_build_option,
      render_architecture: architectureTool.render_architecture,
      lock_architecture: architectureTool.lock_architecture,
      render_cost_table: costTableTool.render_cost_table,
      lock_cost_table: costTableTool.lock_cost_table,
      render_marketing_plans: marketingPlansTool.render_marketing_plans,
      select_marketing_plan: marketingPlansTool.select_marketing_plan,
      refine_marketing_plans: marketingRefinementTool.refine_marketing_plans,
      ...deps.extraTools,
    };

    // Activity agents (build-agents.md): every module active for this session
    // adds its own tools and prompt block to this same call, so e.g. the
    // launch, social and pitch-deck agents all answer within one turn.
    const activeModules = assembleActiveModules(modules, session);
    const moduleSchemas: Record<string, ModuleToolSchema> = {};
    for (const module of activeModules) {
      Object.assign(
        toolRegistry,
        module.getTools({
          sessionStore,
          manifestStore,
          sessionId,
          userId,
          onEvent: (event) => events.push(event),
          hasEntitlement: deps.hasEntitlement,
          getTierProduct: (tierId) => deps.tierCatalog?.find((p) => p.id === tierId),
        }),
      );
      Object.assign(moduleSchemas, module.toolSchemas?.() ?? {});
    }
    const dispatcher = createToolDispatcher({ tools: toolRegistry, logger });

    const compactedHistory = compactChatHistory(session.chat as ChatMessage[], keepRecentMessages);
    const moduleGuidance = activeModules.map((m) => m.buildPrompt(session)).join('\n\n');
    const system = moduleGuidance
      ? `${buildSystemPrompt({ phase: session.phase })}\n\n# Activity agents active this turn\n\n${moduleGuidance}`
      : buildSystemPrompt({ phase: session.phase });
    const messages: AnthropicMessageParam[] = [
      ...toAnthropicMessages(compactedHistory),
      { role: 'user', content: userMessage },
    ];

    const tools = Object.keys(toolRegistry).map((name) => {
      const schema =
        BUILT_IN_TOOL_SCHEMAS[name as keyof typeof BUILT_IN_TOOL_SCHEMAS] ?? moduleSchemas[name];
      return {
        name,
        description: schema?.description ?? `Tool: ${name}`,
        inputSchema: schema?.inputSchema ?? { type: 'object' },
      };
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalText = '';
    let consecutiveFailedRounds = 0;
    let modelCallSucceededAtLeastOnce = false;

    for (let round = 0; round <= maxToolRounds; round++) {
      let result;
      try {
        result = await anthropicClient.streamMessage(
          { model, maxTokens, system, messages, tools },
          {},
        );
      } catch {
        // Model API failure (network error, provider outage, exhausted the
        // client's own retries, etc.) — this is exactly the "no dead-end
        // states" case: never let a thrown error reach the caller as a
        // crashed request. Fall back gracefully and stop this turn here.
        finalText = BACK_ON_TRACK_FALLBACK;
        break;
      }
      modelCallSucceededAtLeastOnce = true;
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;

      const toolUseBlocks = result.content.filter((b) => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        finalText = result.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        break;
      }

      messages.push({ role: 'assistant', content: result.content });

      // A response stopped by the output limit can end mid tool call — its
      // input JSON is incomplete. Never run a tool on a partial input; tell
      // the model plainly so it can retry with shorter content.
      const truncated = result.stopReason === 'max_tokens';
      const toolResults = truncated
        ? toolUseBlocks.map((block) => ({
            toolUseId: block.id,
            isError: true,
            content: {
              ok: false,
              error: 'output_truncated',
              details: [
                'Your response hit the output limit before this tool call finished, so it was not run. Call it again with shorter section text.',
              ],
            },
          }))
        : await Promise.all(toolUseBlocks.map((block) => dispatcher.dispatch(block)));
      const toolResultBlocks = toolResults.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolUseId,
        content: JSON.stringify(r.content),
        is_error: r.isError,
      }));
      // The upcoming round is the last one this turn gets — give the model
      // one explicit heads-up to stop calling tools and reply in text now,
      // rather than silently running out of budget (see WRAP_UP_NUDGE).
      const isLastRoundNext = round + 1 === maxToolRounds;
      messages.push({
        role: 'user',
        content: isLastRoundNext
          ? [...toolResultBlocks, { type: 'text' as const, text: WRAP_UP_NUDGE }]
          : toolResultBlocks,
      });

      // Off-track detection: if every tool call in this round errored, and
      // that's happened for several rounds running, the model is stuck
      // repeating the same mistake rather than genuinely retrying/repairing
      // — stop feeding it more rounds and fall back instead of burning the
      // full maxToolRounds budget on a conversation going nowhere.
      const allFailedThisRound = toolResults.every((r) => r.isError);
      consecutiveFailedRounds = allFailedThisRound ? consecutiveFailedRounds + 1 : 0;
      if (consecutiveFailedRounds >= MAX_CONSECUTIVE_FAILED_ROUNDS) {
        finalText = BACK_ON_TRACK_FALLBACK;
        break;
      }

      if (round === maxToolRounds) {
        finalText = BACK_ON_TRACK_FALLBACK;
      }
    }

    // Only charge for tokens actually returned by a successful model call —
    // a turn that never got a real response has nothing real to bill.
    if (modelCallSucceededAtLeastOnce) {
      const costCents = normalizeUsage(DEFAULT_PRICING, 'anthropic', model, {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        stopReason: null,
      }).costCents;
      await costGuard.recordUsage({ sessionId, userId }, costCents);
    }

    const newChat = compactChatHistory(
      [
        ...compactedHistory,
        { id: randomUUID(), role: 'user', text: userMessage },
        { id: randomUUID(), role: 'agent', text: finalText },
      ],
      keepRecentMessages,
    );
    await sessionStore.update(sessionId, { chat: newChat });

    return { ok: true, reply: finalText, events };
  }

  return { handleTurn };
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
