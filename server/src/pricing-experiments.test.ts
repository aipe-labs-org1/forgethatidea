import { describe, it, expect } from 'vitest';
import {
  assignCohort,
  applyPricingExperiment,
  type PricingExperimentConfig,
} from './pricing-experiments.js';
import { getTierCatalog } from './tier-catalog.js';
import { loadEnv } from './env.js';

const env = loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const baseCatalog = getTierCatalog(env);

describe('assignCohort (#110)', () => {
  it('deterministically assigns the same user to the same cohort every time', () => {
    const config: PricingExperimentConfig = { cohorts: ['control', 'variant-a'] };

    const first = assignCohort('user-1', config);
    const second = assignCohort('user-1', config);

    expect(first).toBe(second);
  });

  it('can assign different users to different cohorts', () => {
    const config: PricingExperimentConfig = { cohorts: ['control', 'variant-a'] };

    const cohorts = new Set(
      Array.from({ length: 20 }, (_, i) => assignCohort(`user-${i}`, config)),
    );

    // With 20 distinct users and 2 cohorts, both should appear at least once
    // — not a strict guarantee, but the assignment function must be capable
    // of producing more than one cohort.
    expect(cohorts.size).toBeGreaterThan(1);
  });

  it('always returns "control" when no experiment is configured', () => {
    const config: PricingExperimentConfig = { cohorts: ['control'] };

    expect(assignCohort('user-1', config)).toBe('control');
  });
});

describe('applyPricingExperiment (#110)', () => {
  it('returns the base catalog unchanged when the cohort has no overrides', () => {
    const config: PricingExperimentConfig = { cohorts: ['control'], overrides: {} };

    const catalog = applyPricingExperiment(baseCatalog, 'control', config);

    expect(catalog).toEqual(baseCatalog);
  });

  it('applies a price override for the assigned cohort', () => {
    const config: PricingExperimentConfig = {
      cohorts: ['control', 'cheap'],
      overrides: { cheap: { 'spec-pack': { priceCents: 990 } } },
    };

    const catalog = applyPricingExperiment(baseCatalog, 'cheap', config);

    expect(catalog.find((p) => p.id === 'spec-pack')!.priceCents).toBe(990);
    // Every other tier is untouched.
    expect(catalog.find((p) => p.id === 'pitch-deck')!.priceCents).toBe(
      baseCatalog.find((p) => p.id === 'pitch-deck')!.priceCents,
    );
  });

  it('applies an offer-copy override for the assigned cohort', () => {
    const config: PricingExperimentConfig = {
      cohorts: ['control', 'urgent-copy'],
      overrides: { 'urgent-copy': { 'spec-pack': { description: 'Limited-time: get it now.' } } },
    };

    const catalog = applyPricingExperiment(baseCatalog, 'urgent-copy', config);

    expect(catalog.find((p) => p.id === 'spec-pack')!.description).toBe(
      'Limited-time: get it now.',
    );
  });

  it('never overrides billingModel or id — only price and copy are experimentable', () => {
    const config: PricingExperimentConfig = {
      cohorts: ['control', 'cheap'],
      overrides: { cheap: { 'spec-pack': { priceCents: 990 } } },
    };

    const catalog = applyPricingExperiment(baseCatalog, 'cheap', config);
    const specPack = catalog.find((p) => p.id === 'spec-pack')!;

    expect(specPack.id).toBe('spec-pack');
    expect(specPack.billingModel).toBe('one_off');
  });
});
