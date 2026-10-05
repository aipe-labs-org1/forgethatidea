import { randomUUID } from 'node:crypto';
import { PHASES, type Phase } from '@forge/shared';
import type { AgentModule, ModuleToolDeps, ModuleToolSchema } from './module-types.js';
import type { SessionCard } from '../phase-gates.js';
import type { TierId } from '../tier-catalog.js';

export interface AdvisorSection {
  key: string;
  label: string;
}

/**
 * One net-new activity agent from docs/build-agents.md (launch, pitch deck,
 * financial angle, ...). Each agent is the same shape — its own guidance,
 * its own `render_<id>` tool, its own canvas card — so the roster is data,
 * not eleven copies of the same render-tool file.
 */
export interface AdvisorSpec {
  id: string;
  label: string;
  /** Earliest spine phase at which this agent joins the turn. */
  minPhase: Phase;
  /** Paid tier that must be owned before this agent may render (#100). */
  tierId?: TierId;
  guidance: string;
  requiredSections: AdvisorSection[];
}

export interface AdvisorCardSection {
  key: string;
  title: string;
  body: string;
  items?: string[];
}

export interface AdvisorSource {
  title: string;
  url: string;
}

export interface AdvisorCardContent {
  label: string;
  summary: string;
  sections: AdvisorCardSection[];
  assumptions: string[];
  sources: AdvisorSource[];
}

export type RenderAdvisorResult =
  | { ok: true; card: SessionCard & { content: AdvisorCardContent } }
  | { ok: false; error: 'session_not_found' }
  | { ok: false; error: 'invalid_input'; details: string[] }
  | { ok: false; error: 'not_entitled'; tierId: TierId; details: string[] };

/**
 * Explicit type guard rather than relying on inline `!result.ok` narrowing —
 * this pattern has caused a Vercel-only build failure multiple times this
 * project even when local tsc is clean on the same TypeScript version.
 */
export function isRenderAdvisorFailure(
  result: RenderAdvisorResult,
): result is Extract<RenderAdvisorResult, { ok: false }> {
  return result.ok === false;
}

export function advisorToolName(id: string): string {
  return `render_${id.replace(/-/g, '_')}`;
}

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function isHttpUrl(value: unknown): boolean {
  if (!isNonEmpty(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

type AdvisorValidation =
  | { ok: true; content: AdvisorCardContent }
  | { ok: false; details: string[] };

/**
 * Explicit type guard rather than relying on inline `!result.ok` narrowing —
 * this pattern has caused a Vercel-only build failure multiple times this
 * project even when local tsc is clean on the same TypeScript version.
 */
function isAdvisorValidationFailure(
  result: AdvisorValidation,
): result is Extract<AdvisorValidation, { ok: false }> {
  return result.ok === false;
}

function validate(spec: AdvisorSpec, input: unknown): AdvisorValidation {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, details: ['input must be an object'] };
  }
  const raw = input as Record<string, unknown>;
  const details: string[] = [];

  if (!isNonEmpty(raw.summary)) details.push('summary must be a non-empty string');

  const sections: AdvisorCardSection[] = [];
  if (!Array.isArray(raw.sections)) {
    details.push('sections must be an array');
  } else {
    raw.sections.forEach((s, i) => {
      const sec = s as Record<string, unknown>;
      if (!isNonEmpty(sec?.key) || !isNonEmpty(sec?.title) || !isNonEmpty(sec?.body)) {
        details.push(`sections[${i}] needs non-empty key, title and body`);
        return;
      }
      const items = Array.isArray(sec.items) ? sec.items.filter(isNonEmpty) : undefined;
      sections.push({
        key: sec.key,
        title: sec.title,
        body: sec.body,
        ...(items ? { items } : {}),
      });
    });
  }

  const present = new Set(sections.map((s) => s.key));
  for (const req of spec.requiredSections) {
    if (!present.has(req.key)) details.push(`missing required section "${req.key}" (${req.label})`);
  }

  const assumptions = Array.isArray(raw.assumptions) ? raw.assumptions.filter(isNonEmpty) : [];

  const sources: AdvisorSource[] = [];
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources)) {
      details.push('sources must be an array');
    } else {
      raw.sources.forEach((s, i) => {
        const src = s as Record<string, unknown>;
        if (!isNonEmpty(src?.title) || !isHttpUrl(src?.url)) {
          details.push(`sources[${i}] needs a title and a real http(s) url`);
          return;
        }
        sources.push({ title: src.title as string, url: src.url as string });
      });
    }
  }

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    content: { label: spec.label, summary: raw.summary as string, sections, assumptions, sources },
  };
}

function buildInputSchema(spec: AdvisorSpec): Record<string, unknown> {
  return {
    type: 'object',
    required: ['summary', 'sections'],
    properties: {
      summary: { type: 'string', description: 'One or two plain-language sentences.' },
      sections: {
        type: 'array',
        description: `Must include every key: ${spec.requiredSections.map((s) => s.key).join(', ')}.`,
        items: {
          type: 'object',
          required: ['key', 'title', 'body'],
          properties: {
            key: { type: 'string', enum: spec.requiredSections.map((s) => s.key) },
            title: { type: 'string' },
            body: { type: 'string' },
            items: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every assumption behind any number or claim.',
      },
      sources: {
        type: 'array',
        description: 'Real sources found via web_search — never invented.',
        items: {
          type: 'object',
          required: ['title', 'url'],
          properties: { title: { type: 'string' }, url: { type: 'string' } },
        },
      },
    },
  };
}

export interface PaywallCardContent {
  kind: 'paywall';
  tierId: TierId;
  agentLabel: string;
  tierName: string;
  description: string;
  priceCents: number | null;
}

export function paywallCardType(tierId: TierId): string {
  return `paywall:${tierId}`;
}

/**
 * Directs a user who isn't entitled to a paid agent to the paywall: one
 * unlock card per tier on the canvas (re-refusals update it in place, never
 * duplicate it), removed again once the agent renders for an owner.
 */
async function putPaywallCard(
  spec: AdvisorSpec,
  tierId: TierId,
  deps: ModuleToolDeps,
): Promise<void> {
  const session = await deps.sessionStore.get(deps.sessionId);
  if (!session) return;

  const product = deps.getTierProduct?.(tierId);
  const type = paywallCardType(tierId);
  const existingCards = session.cards as SessionCard[];
  const existing = existingCards.find((c) => c.type === type);
  const card: SessionCard & { content: PaywallCardContent } = {
    id: existing?.id ?? randomUUID(),
    type,
    status: 'draft',
    content: {
      kind: 'paywall',
      tierId,
      agentLabel: spec.label,
      tierName: product?.name ?? spec.label,
      description: product?.description ?? '',
      priceCents: product?.priceCents ?? null,
    },
  };
  const cards = existing
    ? existingCards.map((c) => (c.type === type ? card : c))
    : [...existingCards, card];

  await deps.sessionStore.update(deps.sessionId, { cards });
  deps.onEvent({ type: 'card_emitted', cardId: card.id, cardType: type });
}

/**
 * Builds an AgentModule for one advisor activity. Joins the turn once the
 * session reaches `minPhase`; a paid agent still joins (so it can explain
 * what it would produce) but its render tool refuses until the tier is
 * owned, returning `not_entitled` so the model offers the unlock instead.
 */
export function createAdvisorModule(spec: AdvisorSpec): AgentModule {
  const toolName = advisorToolName(spec.id);
  const sectionList = spec.requiredSections.map((s) => `${s.key} (${s.label})`).join(', ');
  const minIndex = PHASES.indexOf(spec.minPhase);

  const prompt = [
    `## ${spec.label} agent`,
    spec.guidance,
    `When the user asks for this, call ${toolName} with sections: ${sectionList}. ` +
      'Put every assumption in `assumptions` and cite real sources found with web_search in `sources` — never invent figures, names or URLs. ' +
      `Calling ${toolName} again replaces the card in place.`,
    spec.tierId
      ? `This is a paid agent (${spec.tierId}). If ${toolName} returns not_entitled, say plainly what it would produce and offer the ${spec.tierId} unlock; don't write the content in chat instead.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const schema: ModuleToolSchema = {
    description: `Render the ${spec.label} card on the canvas.`,
    inputSchema: buildInputSchema(spec),
  };

  return {
    id: spec.id,
    buildPrompt: () => prompt,
    isActive: (session) => PHASES.indexOf(session.phase) >= minIndex,
    toolSchemas: () => ({ [toolName]: schema }),
    getTools: (deps) => ({
      [toolName]: async (rawInput: unknown): Promise<RenderAdvisorResult> => {
        if (spec.tierId) {
          const owned = deps.hasEntitlement
            ? await deps.hasEntitlement(deps.userId, spec.tierId)
            : false;
          if (!owned) {
            await putPaywallCard(spec, spec.tierId, deps);
            return {
              ok: false,
              error: 'not_entitled',
              tierId: spec.tierId,
              details: [`${spec.label} needs the ${spec.tierId} unlock`],
            };
          }
        }

        const parsed = validate(spec, rawInput);
        if (isAdvisorValidationFailure(parsed)) {
          return { ok: false, error: 'invalid_input', details: parsed.details };
        }

        const session = await deps.sessionStore.get(deps.sessionId);
        if (!session) return { ok: false, error: 'session_not_found' };

        const existingCards = session.cards as SessionCard[];
        const existing = existingCards.find((c) => c.type === spec.id);
        const card: SessionCard & { content: AdvisorCardContent } = {
          id: existing?.id ?? randomUUID(),
          type: spec.id,
          status: existing ? 'refined' : 'draft',
          content: (parsed as Extract<AdvisorValidation, { ok: true }>).content,
        };
        const paywallType = spec.tierId ? paywallCardType(spec.tierId) : null;
        const cards = (
          existing
            ? existingCards.map((c) => (c.type === spec.id ? card : c))
            : [...existingCards, card]
        ).filter((c) => c.type !== paywallType);

        await deps.sessionStore.update(deps.sessionId, { cards });
        deps.onEvent({ type: 'card_emitted', cardId: card.id, cardType: spec.id });
        return { ok: true, card };
      },
    }),
  };
}
