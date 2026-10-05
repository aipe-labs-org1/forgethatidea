import type { SessionRecord } from '../session-store.js';
import type { SessionStore } from '../session-store.js';
import type { ManifestStore } from '../manifest-store.js';
import type { ToolRegistry } from '../tool-dispatch.js';
import type { TurnEvent } from '../turn-events.js';

/**
 * Dependencies available to every module's `getTools` — the same shapes
 * every existing render-tool factory already takes (store/sessionId/
 * onEvent, plus manifestStore for the manifest tools). A module only reads
 * the subset it actually needs; this is the common superset already
 * threaded through agent-orchestrator.ts today.
 */
export interface ModuleToolDeps {
  sessionStore: SessionStore;
  manifestStore: ManifestStore;
  sessionId: string;
  userId: string;
  onEvent: (event: TurnEvent) => void;
  /** Paid-tier check (entitlements service, #100). Absent means no paid module can run. */
  hasEntitlement?: (userId: string, tierId: string) => Promise<boolean>;
  /** Name, copy and price for a paid tier (tier catalog, #97) — shown on the paywall card. */
  getTierProduct?: (
    tierId: string,
  ) => { name: string; description: string; priceCents: number } | undefined;
}

export interface ModuleToolSchema {
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * One per-activity agent module (docs/build-agents.md): its own prompt
 * guidance and its own tool registry slice, composed into one turn by
 * `module-registry.ts` rather than every activity sharing one flat
 * PHASE_GUIDANCE string and one flat BUILT_IN_TOOL_SCHEMAS list.
 *
 * Deliberately NOT a separate Anthropic-call-per-module loop — see
 * agent-orchestrator.ts's module-assembly step, which still makes exactly
 * one model call per turn, merging every active module's prompt + tools
 * into that one call (same reasoning as the 4 existing render-tool
 * factories already merging into one flat toolRegistry object).
 */
export interface AgentModule {
  /** Stable identifier, e.g. 'onboarding', 'spec-pack', 'pitch-deck'. Never shown to the user. */
  id: string;
  /** This module's guidance block, appended to the shared persona/honesty/conciseness prose every turn it's active. */
  buildPrompt(session: SessionRecord): string;
  /** This module's own tool registry slice — merged with every other active module's into one flat registry for the turn. */
  getTools(deps: ModuleToolDeps): ToolRegistry;
  /** Whether this module is in play for the given session this turn. Spine modules key on `session.phase`; unlockable modules (Epic 6+) will key on `session.unlockedModules`. */
  isActive(session: SessionRecord): boolean;
  /** Schemas for this module's own tools. Spine modules omit it — their schemas live in agent-orchestrator.ts. */
  toolSchemas?(): Record<string, ModuleToolSchema>;
}
