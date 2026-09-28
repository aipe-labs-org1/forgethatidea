import { isTierId, type TierId, type TierProduct } from './tier-catalog.js';
import type { createEntitlementsService } from './entitlements.js';
import type { StripeEventHandler } from './stripe-event-processor.js';
import { emitAnalyticsEvent, type AnalyticsLogger } from './analytics.js';

export interface EntitlementSharingAnomaly {
  userId: string;
  tierId: TierId;
  buyerEmail: string;
  sharedWithUserIds: string[];
}

export interface EntitlementWebhookHandlersDeps {
  entitlements: ReturnType<typeof createEntitlementsService>;
  /** Called when the same buyer email has been granted the same tier under more than one account (Epic 6.10, #107) — e.g. a Slack post, a metric increment. Optional so existing callers/tests that never exercise the gated path don't need one. */
  alertOnAnomaly?: (anomaly: EntitlementSharingAnomaly) => void;
  /** The tier catalog (#97) — used only to look up the real price at grant time for the purchase_completed analytics event (Epic 6.11, #108). Optional so existing callers/tests that don't care about revenue analytics don't need one. */
  catalog?: TierProduct[];
  /** Where purchase_completed is emitted (Epic 6.11, #108) — optional alongside `catalog` for the same reason. */
  analyticsLogger?: AnalyticsLogger;
}

function readBuyerEmail(object: Record<string, unknown>): string | undefined {
  const customerDetails = object.customer_details as Record<string, unknown> | undefined;
  const email = customerDetails?.email;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/**
 * The real amount actually charged, from Stripe's own `amount_total` on
 * the completed session — this is the number that must drive both revenue
 * analytics (#108) and the purchase-price-history guardrail (#110), never
 * a re-lookup of "whatever the catalog says the price is today" (which
 * would silently rewrite history the moment a price or pricing-experiment
 * cohort changes). Falls back to the current catalog price only when
 * amount_total is absent — the unconfigured-Stripe-client stub used before
 * a real key exists never populates it.
 */
function readAmountTotal(object: Record<string, unknown>): number | undefined {
  const amount = object.amount_total;
  return typeof amount === 'number' ? amount : undefined;
}

/** Which pricing-experiment cohort (#110) this checkout session was created under — 'unknown' when absent (an admin-granted or pre-experiment purchase). */
function readCohort(object: Record<string, unknown>): string {
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  const cohort = metadata.cohort;
  return typeof cohort === 'string' && cohort.length > 0 ? cohort : 'unknown';
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
  const { entitlements, alertOnAnomaly, catalog, analyticsLogger } = deps;

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
      const buyerEmail = readBuyerEmail(object);
      const catalogPrice = catalog?.find((p) => p.id === tierId)?.priceCents;
      const purchasePriceCents = readAmountTotal(object) ?? catalogPrice;
      await entitlements.grant(userId, tierId, {
        source: 'purchase',
        reference,
        buyerEmail,
        purchasePriceCents,
      });

      // Revenue analytics (Epic 6.11, #108): the real amount charged
      // (amount_total), never re-derived from the current catalog — a
      // subsequent price or pricing-experiment (#110) change must not
      // retroactively rewrite historical revenue.
      if (analyticsLogger && purchasePriceCents !== undefined) {
        emitAnalyticsEvent(analyticsLogger, {
          type: 'purchase_completed',
          userId,
          tierId,
          amountCents: purchasePriceCents,
          cohort: readCohort(object),
        });
      }

      // Duplicate-account entitlement sharing (Epic 6.10, #107): flag,
      // never block — a false positive here (e.g. a shared family email)
      // shouldn't cost a legitimate buyer their purchase.
      if (buyerEmail && alertOnAnomaly) {
        const sharedWithUserIds = await entitlements.findSharedAccounts(userId, tierId, buyerEmail);
        if (sharedWithUserIds.length > 0) {
          alertOnAnomaly({ userId, tierId, buyerEmail, sharedWithUserIds });
        }
      }
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
