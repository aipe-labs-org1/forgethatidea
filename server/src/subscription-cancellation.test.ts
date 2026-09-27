import { describe, it, expect, vi } from 'vitest';
import {
  createSubscriptionCancellationTool,
  isSubscriptionCancellationFailure,
  type SubscriptionCancelClient,
} from './subscription-cancellation.js';
import { createEntitlementsService, createInMemoryEntitlementStore } from './entitlements.js';

function fakeClient(overrides: Partial<SubscriptionCancelClient> = {}): SubscriptionCancelClient {
  return {
    cancelSubscription: vi.fn(async () => ({ cancelAtPeriodEnd: true, currentPeriodEnd: 123 })),
    ...overrides,
  };
}

async function entitlementsWithSubscription(userId: string, subscriptionId: string) {
  const store = createInMemoryEntitlementStore();
  const entitlements = createEntitlementsService({ store });
  await entitlements.grant(userId, 'app-refinement-topup', {
    source: 'purchase',
    reference: subscriptionId,
  });
  return entitlements;
}

describe('subscription cancellation (#103)', () => {
  it('schedules a cancel-at-period-end for the subscription behind the tier the user owns', async () => {
    const client = fakeClient();
    const entitlements = await entitlementsWithSubscription('user-1', 'sub_abc123');
    const tool = createSubscriptionCancellationTool({ client, entitlements });

    const result = await tool.cancelSubscription('user-1');

    expect(result).toMatchObject({ ok: true, cancelAtPeriodEnd: true });
    expect(client.cancelSubscription).toHaveBeenCalledWith('sub_abc123');
  });

  it('does not revoke the entitlement immediately — that happens later via the webhook once the period actually ends', async () => {
    const client = fakeClient();
    const entitlements = await entitlementsWithSubscription('user-1', 'sub_abc123');
    const tool = createSubscriptionCancellationTool({ client, entitlements });

    await tool.cancelSubscription('user-1');

    expect(await entitlements.hasEntitlement('user-1', 'app-refinement-topup')).toBe(true);
  });

  it('rejects when the user has no active subscription to cancel', async () => {
    const client = fakeClient();
    const store = createInMemoryEntitlementStore();
    const entitlements = createEntitlementsService({ store });
    const tool = createSubscriptionCancellationTool({ client, entitlements });

    const result = await tool.cancelSubscription('user-1');

    expect(isSubscriptionCancellationFailure(result)).toBe(true);
    if (isSubscriptionCancellationFailure(result)) {
      expect(result.error).toBe('no_active_subscription');
    }
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });

  it('surfaces a client-level failure as a typed result rather than throwing', async () => {
    const client = fakeClient({
      cancelSubscription: vi.fn(async () => {
        throw new Error('stripe API unreachable');
      }),
    });
    const entitlements = await entitlementsWithSubscription('user-1', 'sub_abc123');
    const tool = createSubscriptionCancellationTool({ client, entitlements });

    const result = await tool.cancelSubscription('user-1');

    expect(isSubscriptionCancellationFailure(result)).toBe(true);
    if (isSubscriptionCancellationFailure(result)) {
      expect(result.error).toBe('cancellation_failed');
    }
  });
});
