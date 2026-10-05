import type { TierId } from '../api.js';

export interface AdvisorCardSection {
  key: string;
  title: string;
  body: string;
  items?: string[];
}

export interface AdvisorCardContent {
  label: string;
  summary: string;
  sections: AdvisorCardSection[];
  assumptions: string[];
  sources: { title: string; url: string }[];
}

/** True for any card produced by an activity agent (server/src/agents/advisor-module.ts). */
export function isAdvisorContent(content: unknown): content is AdvisorCardContent {
  if (typeof content !== 'object' || content === null) return false;
  const c = content as Record<string, unknown>;
  return typeof c.label === 'string' && typeof c.summary === 'string' && Array.isArray(c.sections);
}

export interface PaywallCardContent {
  kind: 'paywall';
  tierId: TierId;
  agentLabel: string;
  tierName: string;
  description: string;
  priceCents: number | null;
}

/** True for the unlock card a paid agent leaves when the user doesn't own its tier. */
export function isPaywallContent(content: unknown): content is PaywallCardContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    (content as Record<string, unknown>).kind === 'paywall' &&
    typeof (content as Record<string, unknown>).tierId === 'string'
  );
}
