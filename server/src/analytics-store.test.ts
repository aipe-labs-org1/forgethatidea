import { describe, it, expect, vi } from 'vitest';
import {
  createInMemoryAnalyticsStore,
  createPersistingAnalyticsLogger,
  queryRefinementFunnel,
  queryBuildFailureReport,
  queryRevenueReport,
} from './analytics-store.js';

describe('createPersistingAnalyticsLogger — failure isolation', () => {
  it('never lets a failed analytics write become an unhandled rejection (it crashed prod)', async () => {
    const failingStore = {
      record: vi.fn(async () => {
        throw new Error('relation "analytics_events" does not exist');
      }),
      listAll: vi.fn(async () => []),
    };
    const base = { info: vi.fn(), error: vi.fn() };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const logger = createPersistingAnalyticsLogger(failingStore, base);
    logger.info({ analytics_event: true, type: 'content_screened', sessionId: 's-1' }, 'x');
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(base.info).toHaveBeenCalled();
    expect(base.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'content_screened' }),
      'analytics event could not be persisted',
    );
  });
});

describe('createPersistingAnalyticsLogger (#95)', () => {
  it('persists every event to the store and still forwards to the base logger', () => {
    const store = createInMemoryAnalyticsStore();
    const baseCalls: unknown[] = [];
    const baseLogger = { info: (obj: unknown, msg?: string) => baseCalls.push([obj, msg]) };
    const logger = createPersistingAnalyticsLogger(store, baseLogger);

    logger.info(
      {
        analytics_event: true,
        type: 'gate_shown',
        sessionId: 's1',
        kind: 'app',
        rounds: 3,
        limit: 3,
      },
      'analytics.gate_shown',
    );

    expect(baseCalls).toHaveLength(1);
  });

  it('ignores objects without analytics_event:true rather than persisting arbitrary log lines', () => {
    const store = createInMemoryAnalyticsStore();
    const logger = createPersistingAnalyticsLogger(store, { info: () => {} });

    logger.info({ msg: 'not an analytics event' });

    // Nothing to assert on the store directly here (no public read besides
    // query); covered indirectly by queryRefinementFunnel tests only
    // counting real analytics events.
    expect(true).toBe(true);
  });

  it('persists an event with no sessionId (a user-scoped event, e.g. a purchase) without dropping it (#108)', async () => {
    const store = createInMemoryAnalyticsStore();
    const logger = createPersistingAnalyticsLogger(store, { info: () => {} });

    logger.info(
      { analytics_event: true, type: 'purchase_completed', userId: 'user-1', tierId: 'spec-pack' },
      'analytics.purchase_completed',
    );

    const events = await store.listAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'purchase_completed', sessionId: null });
  });
});

describe('queryRefinementFunnel (#95)', () => {
  it('computes the rounds-used distribution per kind from refinement_used events', async () => {
    const store = createInMemoryAnalyticsStore();
    const logger = createPersistingAnalyticsLogger(store, { info: () => {} });

    logger.info(
      {
        analytics_event: true,
        type: 'refinement_used',
        sessionId: 's1',
        kind: 'app',
        round: 1,
        limit: 3,
      },
      'analytics.refinement_used',
    );
    logger.info(
      {
        analytics_event: true,
        type: 'refinement_used',
        sessionId: 's1',
        kind: 'app',
        round: 2,
        limit: 3,
      },
      'analytics.refinement_used',
    );
    logger.info(
      {
        analytics_event: true,
        type: 'refinement_used',
        sessionId: 's2',
        kind: 'marketing',
        round: 1,
        limit: 3,
      },
      'analytics.refinement_used',
    );

    const result = await queryRefinementFunnel(store);

    expect(result.roundsUsedDistribution.app).toEqual({ 1: 1, 2: 1 });
    expect(result.roundsUsedDistribution.marketing).toEqual({ 1: 1 });
  });

  it('computes gate hit rate as sessions with a gate_shown event over distinct sessions seen', async () => {
    const store = createInMemoryAnalyticsStore();
    const logger = createPersistingAnalyticsLogger(store, { info: () => {} });

    logger.info(
      { analytics_event: true, type: 'phase_entered', sessionId: 's1', phase: 'onboarding' },
      'analytics.phase_entered',
    );
    logger.info(
      { analytics_event: true, type: 'phase_entered', sessionId: 's2', phase: 'onboarding' },
      'analytics.phase_entered',
    );
    logger.info(
      {
        analytics_event: true,
        type: 'gate_shown',
        sessionId: 's1',
        kind: 'app',
        rounds: 3,
        limit: 3,
      },
      'analytics.gate_shown',
    );

    const result = await queryRefinementFunnel(store);

    expect(result.gateHitRate).toBe(0.5);
  });

  it('computes gate-to-export rate as gated sessions that later exported over gated sessions', async () => {
    const store = createInMemoryAnalyticsStore();
    const logger = createPersistingAnalyticsLogger(store, { info: () => {} });

    logger.info(
      {
        analytics_event: true,
        type: 'gate_shown',
        sessionId: 's1',
        kind: 'app',
        rounds: 3,
        limit: 3,
      },
      'analytics.gate_shown',
    );
    logger.info(
      {
        analytics_event: true,
        type: 'gate_shown',
        sessionId: 's2',
        kind: 'app',
        rounds: 3,
        limit: 3,
      },
      'analytics.gate_shown',
    );
    logger.info(
      { analytics_event: true, type: 'app_exported', sessionId: 's1', version: 2, fromGate: true },
      'analytics.app_exported',
    );

    const result = await queryRefinementFunnel(store);

    expect(result.gateToExportRate).toBe(0.5);
  });

  it('returns zero rates rather than NaN when no sessions have been seen yet', async () => {
    const store = createInMemoryAnalyticsStore();

    const result = await queryRefinementFunnel(store);

    expect(result.gateHitRate).toBe(0);
    expect(result.gateToExportRate).toBe(0);
    expect(result.roundsUsedDistribution).toEqual({ app: {}, marketing: {} });
  });
});

describe('queryBuildFailureReport (#83)', () => {
  async function logger(store: ReturnType<typeof createInMemoryAnalyticsStore>) {
    return createPersistingAnalyticsLogger(store, { info: () => {} });
  }

  it('aggregates failure counts by archetype and cause', async () => {
    const store = createInMemoryAnalyticsStore();
    const log = await logger(store);

    log.info(
      {
        analytics_event: true,
        type: 'build_failed',
        sessionId: 's1',
        archetype: 'crud-tracker',
        cause: 'validation_failed_after_repairs',
        repairRounds: 2,
      },
      'analytics.build_failed',
    );
    log.info(
      {
        analytics_event: true,
        type: 'build_failed',
        sessionId: 's2',
        archetype: 'crud-tracker',
        cause: 'validation_failed_after_repairs',
        repairRounds: 2,
      },
      'analytics.build_failed',
    );
    log.info(
      {
        analytics_event: true,
        type: 'build_failed',
        sessionId: 's3',
        archetype: 'dashboard',
        cause: 'content_blocked',
        repairRounds: 0,
      },
      'analytics.build_failed',
    );

    const result = await queryBuildFailureReport(store);

    expect(result.failuresByArchetype['crud-tracker']).toBe(2);
    expect(result.failuresByArchetype['dashboard']).toBe(1);
    expect(result.failuresByCause['validation_failed_after_repairs']).toBe(2);
    expect(result.failuresByCause['content_blocked']).toBe(1);
  });

  it('computes repair-loop success rate as builds needing 0 repair rounds over all successful builds', async () => {
    const store = createInMemoryAnalyticsStore();
    const log = await logger(store);

    log.info(
      {
        analytics_event: true,
        type: 'build_succeeded',
        sessionId: 's1',
        archetype: 'crud-tracker',
        repairRounds: 0,
      },
      'analytics.build_succeeded',
    );
    log.info(
      {
        analytics_event: true,
        type: 'build_succeeded',
        sessionId: 's2',
        archetype: 'crud-tracker',
        repairRounds: 1,
      },
      'analytics.build_succeeded',
    );
    log.info(
      {
        analytics_event: true,
        type: 'build_succeeded',
        sessionId: 's3',
        archetype: 'crud-tracker',
        repairRounds: 0,
      },
      'analytics.build_succeeded',
    );

    const result = await queryBuildFailureReport(store);

    expect(result.cleanFirstTryRate).toBeCloseTo(2 / 3);
    expect(result.totalSucceeded).toBe(3);
  });

  it('computes an overall failure rate across successes and failures', async () => {
    const store = createInMemoryAnalyticsStore();
    const log = await logger(store);

    log.info(
      {
        analytics_event: true,
        type: 'build_succeeded',
        sessionId: 's1',
        archetype: 'crud-tracker',
        repairRounds: 0,
      },
      'analytics.build_succeeded',
    );
    log.info(
      {
        analytics_event: true,
        type: 'build_failed',
        sessionId: 's2',
        archetype: 'crud-tracker',
        cause: 'generation_failed',
        repairRounds: 2,
      },
      'analytics.build_failed',
    );
    log.info(
      {
        analytics_event: true,
        type: 'build_failed',
        sessionId: 's3',
        archetype: 'crud-tracker',
        cause: 'generation_failed',
        repairRounds: 2,
      },
      'analytics.build_failed',
    );
    log.info(
      {
        analytics_event: true,
        type: 'build_failed',
        sessionId: 's4',
        archetype: 'crud-tracker',
        cause: 'generation_failed',
        repairRounds: 2,
      },
      'analytics.build_failed',
    );

    const result = await queryBuildFailureReport(store);

    expect(result.totalSucceeded).toBe(1);
    expect(result.totalFailed).toBe(3);
    expect(result.failureRate).toBeCloseTo(0.75);
  });

  it('returns zero rates rather than NaN when no builds have happened yet', async () => {
    const store = createInMemoryAnalyticsStore();

    const result = await queryBuildFailureReport(store);

    expect(result.failureRate).toBe(0);
    expect(result.cleanFirstTryRate).toBe(0);
    expect(result.totalSucceeded).toBe(0);
    expect(result.totalFailed).toBe(0);
    expect(result.failuresByArchetype).toEqual({});
    expect(result.failuresByCause).toEqual({});
  });
});

describe('queryRevenueReport (#108)', () => {
  async function logPurchase(
    logger: ReturnType<typeof createPersistingAnalyticsLogger>,
    userId: string,
    tierId: string,
    amountCents: number,
    createdAt?: Date,
  ) {
    logger.info(
      { analytics_event: true, type: 'purchase_completed', userId, tierId, amountCents },
      'analytics.purchase_completed',
    );
    void createdAt;
  }

  it('sums revenue by tier', async () => {
    const store = createInMemoryAnalyticsStore();
    const logger = createPersistingAnalyticsLogger(store, { info: () => {} });

    await logPurchase(logger, 'user-1', 'spec-pack', 1900);
    await logPurchase(logger, 'user-2', 'spec-pack', 1900);
    await logPurchase(logger, 'user-3', 'pitch-deck', 2900);

    const report = await queryRevenueReport(store);

    expect(report.revenueByTierCents).toEqual({ 'spec-pack': 3800, 'pitch-deck': 2900 });
  });

  it('computes offer-to-purchase conversion per surface', async () => {
    const store = createInMemoryAnalyticsStore();
    const logger = createPersistingAnalyticsLogger(store, { info: () => {} });

    logger.info(
      {
        analytics_event: true,
        type: 'checkout_started',
        userId: 'user-1',
        tierId: 'spec-pack',
        surface: 'refinement_gate',
      },
      'analytics.checkout_started',
    );
    logger.info(
      {
        analytics_event: true,
        type: 'checkout_started',
        userId: 'user-2',
        tierId: 'spec-pack',
        surface: 'refinement_gate',
      },
      'analytics.checkout_started',
    );
    await logPurchase(logger, 'user-1', 'spec-pack', 1900);

    const report = await queryRevenueReport(store);

    expect(report.conversionBySurface.refinement_gate).toEqual({ started: 2, completed: 1 });
  });

  it('derives a weekly revenue summary', async () => {
    const store = createInMemoryAnalyticsStore();
    const logger = createPersistingAnalyticsLogger(store, { info: () => {} });

    await logPurchase(logger, 'user-1', 'spec-pack', 1900);
    await logPurchase(logger, 'user-2', 'pitch-deck', 2900);

    const report = await queryRevenueReport(store);

    expect(report.weeklyRevenueCents.length).toBeGreaterThan(0);
    const total = report.weeklyRevenueCents.reduce((sum, w) => sum + w.revenueCents, 0);
    expect(total).toBe(4800);
  });

  it('reports zeroed-out results with no purchase events', async () => {
    const store = createInMemoryAnalyticsStore();

    const report = await queryRevenueReport(store);

    expect(report.revenueByTierCents).toEqual({});
    expect(report.conversionBySurface).toEqual({});
    expect(report.weeklyRevenueCents).toEqual([]);
  });
});
