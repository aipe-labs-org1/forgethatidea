import { isTierId, type TierId } from './tier-catalog.js';
import type { createEntitlementsService } from './entitlements.js';
import type { StripeEventHandler } from './stripe-event-processor.js';

export interface EntitlementWebhookHandlersDeps {
  entitlements: ReturnType<typeof createEntitlementsService>;
}

function readMetadata(object: Record<string, unknown>): { userId: string; tierId: TierId } {
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  const userId = metadata.userId;
  const tierId = metadata.tierId;

  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error(`stripe event ${String(object.id)} is missing metadata.userId`);
  }
  if (typeof tierId !== 'string' || !isTierId(tierId)) {
    throw new Error(`stripe event ${String(object.id)} has an unrecognized metadata.tierId`);
  }

  return { userId, tierId };
}

/**
 * Bridges verified, deduped Stripe events (stripe-event-processor.ts, #99)
 * to the entitlements service (#100) — this is what actually makes
 * "grants on webhook, revokes on refund/cancel" true. Throws rather than
 * silently no-op-ing on missing/malformed metadata: a checkout session with
 * no way to know which user or tier it paid for is a bug in checkout-session
 * creation (stripe-checkout.ts must always set this metadata), not a case
 * to quietly ignore — the processor's alertOnFailure (#99) surfaces it and
 * Stripe retries, rather than an entitlement silently never being granted.
 */
export function createEntitlementWebhookHandlers(
  deps: EntitlementWebhookHandlersDeps,
): Record<string, StripeEventHandler> {
  const { entitlements } = deps;

  return {
    'checkout.session.completed': async (object) => {
      const { userId, tierId } = readMetadata(object);
      // A subscription-mode session (the app-refinement top-up) carries
      // Stripe's own `subscription` id on the completed session — store
      // that as the reference instead of the session id, since that's what
      // a later self-serve cancel (#103) actually needs to call
      // stripe.subscriptions.cancel on. A one-off session has no
      // `subscription` field, so it falls back to the session id, same as
      // before.
      const subscriptionId = object.subscription;
      const reference =
        typeof subscriptionId === 'string' && subscriptionId.length > 0
          ? subscriptionId
          : String(object.id);
      await entitlements.grant(userId, tierId, { source: 'purchase', reference });
    },
    'charge.refunded': async (object) => {
      const { userId, tierId } = readMetadata(object);
      await entitlements.revoke(userId, tierId, { source: 'refund', reference: String(object.id) });
    },
    'customer.subscription.deleted': async (object) => {
      const { userId, tierId } = readMetadata(object);
      await entitlements.revoke(userId, tierId, {
        source: 'subscription_cancel',
        reference: String(object.id),
      });
    },
  };
}
