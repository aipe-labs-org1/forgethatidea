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
