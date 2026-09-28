import { createHash } from 'node:crypto';
import type { TierId, TierProduct } from './tier-catalog.js';

export interface TierOverride {
  priceCents?: number;
  description?: string;
}

export interface PricingExperimentConfig {
  /** Every cohort id this experiment can assign a user to — first entry is the control/default. */
  cohorts: string[];
  /** Per-cohort, per-tier overrides — only price and copy are experimentable; id/billingModel never change (#110's "prices/copy swappable via config"). */
  overrides?: Record<string, Partial<Record<TierId, TierOverride>>>;
}

/**
 * Deterministic cohort assignment (Epic 6.13, #110): the same userId always
 * lands in the same cohort, computed from a stable hash rather than random
 * or session-based assignment — a user must see consistent pricing across
 * page loads/devices, not a new roll every time. Not cryptographically
 * meaningful; this only needs a stable, roughly-even split across cohorts.
 */
export function assignCohort(userId: string, config: PricingExperimentConfig): string {
  if (config.cohorts.length === 1) return config.cohorts[0]!;

  const hash = createHash('sha256').update(userId).digest();
  const index = hash[0]! % config.cohorts.length;
  return config.cohorts[index]!;
}

/**
 * Applies a cohort's price/copy overrides on top of the base tier catalog
 * (#97) — the single source of truth stays getTierCatalog; this is a pure
 * transform layered on its output, never a second catalog definition.
 * Every field not explicitly overridden (including id and billingModel,
 * which are never experimentable) passes through unchanged.
 */
export function applyPricingExperiment(
  baseCatalog: TierProduct[],
  cohort: string,
  config: PricingExperimentConfig,
): TierProduct[] {
  const cohortOverrides = config.overrides?.[cohort];
  if (!cohortOverrides) return baseCatalog;

  return baseCatalog.map((product) => {
    const override = cohortOverrides[product.id];
    if (!override) return product;
    return {
      ...product,
      priceCents: override.priceCents ?? product.priceCents,
      description: override.description ?? product.description,
    };
  });
}
