import type { createEntitlementsService } from './entitlements.js';

export interface SubscriptionCancelResult {
  cancelAtPeriodEnd: boolean;
  /** Unix seconds — when access actually ends, matching Stripe's own field name. */
  currentPeriodEnd: number;
}

/**
 * Thin wrapper over the real Stripe SDK's `stripe.subscriptions.cancel`
 * (Epic 6.7, #103) — swappable so this is unit-testable against a fake,
 * same shape as StripeClient (stripe-checkout.ts). The real implementation
 * isn't built yet: same deferred-pending-a-live-key gap as every other
 * Stripe integration point in this codebase so far.
 */
export interface SubscriptionCancelClient {
  cancelSubscription(subscriptionId: string): Promise<SubscriptionCancelResult>;
}

export function createUnconfiguredSubscriptionCancelClient(): SubscriptionCancelClient {
  return {
    cancelSubscription: () =>
      Promise.reject(new Error('Stripe is not configured (missing STRIPE_SECRET_KEY)')),
  };
}

export interface SubscriptionCancellationToolDeps {
  client: SubscriptionCancelClient;
  entitlements: ReturnType<typeof createEntitlementsService>;
}

/**
 * Plain-language cancellation policy (#103's "policy documented
 * user-facing") — returned alongside every successful cancel so the user
 * sees exactly what happens, rather than this living only in an
 * undiscoverable legal page (Epic 6.10, #106, not yet built). Full legal
 * copy for T&Cs/refund policy pages is that issue's job; this is the
 * plain-English confirmation a user reads at the moment they act.
 */
export const CANCELLATION_POLICY =
  'Your subscription will stay active until the end of the current billing period — you keep full access until then. No further charges will be made, and there is no partial refund for the remaining days in the period.';

export type SubscriptionCancellationResult =
  | { ok: true; cancelAtPeriodEnd: boolean; currentPeriodEnd: number; policy: string }
  | { ok: false; error: 'no_active_subscription' }
  | { ok: false; error: 'cancellation_failed'; details: string };

/**
 * Explicit type guard rather than relying on inline `!result.ok` narrowing —
 * this pattern has caused a Vercel-only build failure multiple times this
 * project even when local tsc is clean on the same TypeScript version.
 */
export function isSubscriptionCancellationFailure(
  result: SubscriptionCancellationResult,
): result is Extract<SubscriptionCancellationResult, { ok: false }> {
  return result.ok === false;
}

/**
 * Self-serve subscription cancellation (Epic 6.7): the only subscription
 * tier is the app-refinement top-up (tier-catalog.ts) — looks up the real
 * Stripe subscription id behind the user's current grant
 * (entitlements.findGrantReference, populated from the checkout-completed
 * webhook's `subscription` field, #103) and schedules Stripe's own
 * cancel-at-period-end rather than an immediate cancel, satisfying "sub
 * cancel self-serve, effective end of period."
 *
 * Deliberately does NOT revoke the entitlement here — access should
 * continue until the period the user already paid for actually ends.
 * The real revoke happens later, when Stripe's `customer.subscription.
 * deleted` webhook fires at period end and reaches
 * entitlement-webhook-handlers.ts, exactly like any other revoke.
 */
export function createSubscriptionCancellationTool(deps: SubscriptionCancellationToolDeps) {
  const { client, entitlements } = deps;

  async function cancelSubscription(userId: string): Promise<SubscriptionCancellationResult> {
    const subscriptionId = await entitlements.findGrantReference(userId, 'app-refinement-topup');
    if (!subscriptionId) {
      return { ok: false, error: 'no_active_subscription' };
    }

    try {
      const result = await client.cancelSubscription(subscriptionId);
      return {
        ok: true,
        cancelAtPeriodEnd: result.cancelAtPeriodEnd,
        currentPeriodEnd: result.currentPeriodEnd,
        policy: CANCELLATION_POLICY,
      };
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      return { ok: false, error: 'cancellation_failed', details };
    }
  }

  return { cancelSubscription };
}
