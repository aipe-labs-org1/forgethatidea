import { describe, it, expect } from 'vitest';
import { createEntitlementWebhookHandlers } from './entitlement-webhook-handlers.js';
import { createEntitlementsService, createInMemoryEntitlementStore } from './entitlements.js';

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
});
