import { describe, it, expect, vi } from 'vitest';
import { createEntitlementWebhookHandlers } from './entitlement-webhook-handlers.js';
import { createEntitlementsService, createInMemoryEntitlementStore } from './entitlements.js';
import { getTierCatalog } from './tier-catalog.js';
import { loadEnv } from './env.js';

const testCatalog = getTierCatalog(loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));

function service() {
  const store = createInMemoryEntitlementStore();
  return createEntitlementsService({ store });
}

describe('entitlement webhook handlers (#100)', () => {
  it('grants the tier on checkout.session.completed, keyed by session metadata', async () => {
    const entitlements = service();
    const handlers = createEntitlementWebhookHandlers({ entitlements });

    await handlers['checkout.session.completed']!({
      id: 'cs_test_1',
      metadata: { userId: 'user-1', tierId: 'spec-pack' },
    });

    expect(await entitlements.hasEntitlement('user-1', 'spec-pack')).toBe(true);
  });

  it('revokes the tier on charge.refunded, keyed by charge metadata', async () => {
    const entitlements = service();
    const handlers = createEntitlementWebhookHandlers({ entitlements });

    await handlers['checkout.session.completed']!({
      id: 'cs_test_1',
      metadata: { userId: 'user-1', tierId: 'spec-pack' },
    });
    expect(await entitlements.hasEntitlement('user-1', 'spec-pack')).toBe(true);

    await handlers['charge.refunded']!({
      id: 'ch_test_1',
      metadata: { userId: 'user-1', tierId: 'spec-pack' },
    });

    expect(await entitlements.hasEntitlement('user-1', 'spec-pack')).toBe(false);
  });

  it('revokes the subscription tier on customer.subscription.deleted', async () => {
    const entitlements = service();
    const handlers = createEntitlementWebhookHandlers({ entitlements });

    await handlers['checkout.session.completed']!({
      id: 'cs_test_1',
      metadata: { userId: 'user-1', tierId: 'app-refinement-topup' },
    });
    expect(await entitlements.hasEntitlement('user-1', 'app-refinement-topup')).toBe(true);

    await handlers['customer.subscription.deleted']!({
      id: 'sub_test_1',
      metadata: { userId: 'user-1', tierId: 'app-refinement-topup' },
    });

    expect(await entitlements.hasEntitlement('user-1', 'app-refinement-topup')).toBe(false);
  });

  it('throws (rather than silently no-op-ing) when metadata is missing the tier or user id', async () => {
    const entitlements = service();
    const handlers = createEntitlementWebhookHandlers({ entitlements });

    await expect(
      handlers['checkout.session.completed']!({ id: 'cs_test_1', metadata: {} }),
    ).rejects.toThrow();
  });

  it('throws when metadata names an unrecognized tier id', async () => {
    const entitlements = service();
    const handlers = createEntitlementWebhookHandlers({ entitlements });

    await expect(
      handlers['checkout.session.completed']!({
        id: 'cs_test_1',
        metadata: { userId: 'user-1', tierId: 'not-a-real-tier' },
      }),
    ).rejects.toThrow();
  });

  it('stores the Stripe subscription id (not the checkout session id) as the grant reference for a subscription-mode session (#103)', async () => {
    const entitlements = service();
    const handlers = createEntitlementWebhookHandlers({ entitlements });

    await handlers['checkout.session.completed']!({
      id: 'cs_test_1',
      subscription: 'sub_abc123',
      metadata: { userId: 'user-1', tierId: 'app-refinement-topup' },
    });

    expect(await entitlements.findGrantReference('user-1', 'app-refinement-topup')).toBe(
      'sub_abc123',
    );
  });

  it('falls back to the session id as the grant reference for a one-off (non-subscription) session', async () => {
    const entitlements = service();
    const handlers = createEntitlementWebhookHandlers({ entitlements });

    await handlers['checkout.session.completed']!({
      id: 'cs_test_1',
      metadata: { userId: 'user-1', tierId: 'spec-pack' },
    });

    expect(await entitlements.findGrantReference('user-1', 'spec-pack')).toBe('cs_test_1');
  });

  it('captures the buyer email from customer_details and flags a shared-account anomaly (#107)', async () => {
    const entitlements = service();
    const alertOnAnomaly = vi.fn();
    const handlers = createEntitlementWebhookHandlers({ entitlements, alertOnAnomaly });

    await handlers['checkout.session.completed']!({
      id: 'cs_1',
      customer_details: { email: 'shared@example.com' },
      metadata: { userId: 'user-1', tierId: 'spec-pack' },
    });
    await handlers['checkout.session.completed']!({
      id: 'cs_2',
      customer_details: { email: 'shared@example.com' },
      metadata: { userId: 'user-2', tierId: 'spec-pack' },
    });

    expect(alertOnAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        tierId: 'spec-pack',
        buyerEmail: 'shared@example.com',
        sharedWithUserIds: ['user-1'],
      }),
    );
  });

  it('does not alert when no other account shares the buyer email', async () => {
    const entitlements = service();
    const alertOnAnomaly = vi.fn();
    const handlers = createEntitlementWebhookHandlers({ entitlements, alertOnAnomaly });

    await handlers['checkout.session.completed']!({
      id: 'cs_1',
      customer_details: { email: 'unique@example.com' },
      metadata: { userId: 'user-1', tierId: 'spec-pack' },
    });

    expect(alertOnAnomaly).not.toHaveBeenCalled();
  });

  it('does not throw or alert when customer_details is absent (e.g. no real key configured)', async () => {
    const entitlements = service();
    const alertOnAnomaly = vi.fn();
    const handlers = createEntitlementWebhookHandlers({ entitlements, alertOnAnomaly });

    await expect(
      handlers['checkout.session.completed']!({
        id: 'cs_1',
        metadata: { userId: 'user-1', tierId: 'spec-pack' },
      }),
    ).resolves.not.toThrow();
    expect(alertOnAnomaly).not.toHaveBeenCalled();
  });

  it('emits a purchase_completed analytics event using the real amount_total charged, not the current catalog price (#108, #110)', async () => {
    const entitlements = service();
    const analyticsLogger = { info: vi.fn() };
    const handlers = createEntitlementWebhookHandlers({
      entitlements,
      catalog: testCatalog,
      analyticsLogger,
    });

    await handlers['checkout.session.completed']!({
      id: 'cs_1',
      amount_total: 990,
      metadata: { userId: 'user-1', tierId: 'spec-pack' },
    });

    expect(analyticsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        analytics_event: true,
        type: 'purchase_completed',
        userId: 'user-1',
        tierId: 'spec-pack',
        amountCents: 990,
      }),
      'analytics.purchase_completed',
    );
  });

  it('falls back to the current catalog price when amount_total is absent (e.g. no real key configured)', async () => {
    const entitlements = service();
    const analyticsLogger = { info: vi.fn() };
    const handlers = createEntitlementWebhookHandlers({
      entitlements,
      catalog: testCatalog,
      analyticsLogger,
    });

    await handlers['checkout.session.completed']!({
      id: 'cs_1',
      metadata: { userId: 'user-1', tierId: 'spec-pack' },
    });

    const specPackPrice = testCatalog.find((p) => p.id === 'spec-pack')!.priceCents;
    expect(analyticsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'purchase_completed', amountCents: specPackPrice }),
      'analytics.purchase_completed',
    );
  });

  it('captures the real amount_total as purchasePriceCents on the entitlement grant (#110)', async () => {
    const entitlements = service();
    const handlers = createEntitlementWebhookHandlers({ entitlements });

    await handlers['checkout.session.completed']!({
      id: 'cs_1',
      amount_total: 300,
      metadata: { userId: 'user-1', tierId: 'app-refinement-topup' },
    });

    expect(await entitlements.findHistoricalPriceCents('user-1', 'app-refinement-topup')).toBe(300);
  });

  it('includes the cohort from session metadata on purchase_completed (#110)', async () => {
    const entitlements = service();
    const analyticsLogger = { info: vi.fn() };
    const handlers = createEntitlementWebhookHandlers({
      entitlements,
      catalog: testCatalog,
      analyticsLogger,
    });

    await handlers['checkout.session.completed']!({
      id: 'cs_1',
      amount_total: 990,
      metadata: { userId: 'user-1', tierId: 'spec-pack', cohort: 'cheap' },
    });

    expect(analyticsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'purchase_completed', cohort: 'cheap' }),
      'analytics.purchase_completed',
    );
  });

  it('defaults cohort to "unknown" when metadata has none (e.g. an admin-granted or pre-experiment purchase)', async () => {
    const entitlements = service();
    const analyticsLogger = { info: vi.fn() };
    const handlers = createEntitlementWebhookHandlers({
      entitlements,
      catalog: testCatalog,
      analyticsLogger,
    });

    await handlers['checkout.session.completed']!({
      id: 'cs_1',
      amount_total: 990,
      metadata: { userId: 'user-1', tierId: 'spec-pack' },
    });

    expect(analyticsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'purchase_completed', cohort: 'unknown' }),
      'analytics.purchase_completed',
    );
  });
});
