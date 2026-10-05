import { describe, it, expect } from 'vitest';
import { ADVISOR_SPECS, ADVISOR_MODULES } from './advisor-roster.js';
import { SPINE_MODULES } from './spine-modules.js';
import { advisorToolName } from './advisor-module.js';

describe('advisor roster (build-agents.md)', () => {
  it('covers every net-new activity in build-agents.md', () => {
    expect(ADVISOR_SPECS.map((s) => s.id).sort()).toEqual(
      [
        'data-protection',
        'deployment',
        'epics-export',
        'financial',
        'funding',
        'launch',
        'paywall-geo',
        'pitch-deck',
        'social-seo',
        'spec-pack',
      ].sort(),
    );
  });

  it('has unique ids that never collide with a spine module', () => {
    const ids = [...ADVISOR_SPECS.map((s) => s.id), ...SPINE_MODULES.map((m) => m.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gates the paid activities behind their tiers and leaves the rest free', () => {
    const tiers = Object.fromEntries(ADVISOR_SPECS.map((s) => [s.id, s.tierId ?? null]));
    expect(tiers).toMatchObject({
      'spec-pack': 'spec-pack',
      'epics-export': 'spec-pack',
      'pitch-deck': 'pitch-deck',
      financial: 'financial-pack',
      funding: 'financial-pack',
      launch: null,
      'social-seo': null,
      'data-protection': null,
      deployment: null,
      'paywall-geo': null,
    });
  });

  it('gives every agent at least three required sections and real guidance', () => {
    for (const spec of ADVISOR_SPECS) {
      expect(spec.requiredSections.length).toBeGreaterThanOrEqual(3);
      expect(spec.guidance.length).toBeGreaterThan(80);
    }
  });

  it('builds one module per spec, each exposing its render tool', () => {
    expect(ADVISOR_MODULES).toHaveLength(ADVISOR_SPECS.length);
    for (const m of ADVISOR_MODULES) {
      expect(Object.keys(m.toolSchemas!())).toEqual([advisorToolName(m.id)]);
    }
  });
});
