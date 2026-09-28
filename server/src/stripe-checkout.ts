import { isTierId, type TierId, type TierProduct } from './tier-catalog.js';
import type { createDisclaimerAcceptanceService } from './disclaimer-acceptance.js';
import {
  FINANCIAL_PACK_DISCLAIMER_ID,
  FINANCIAL_PACK_DISCLAIMER_VERSION,
} from './financial-pack-disclaimer.js';
import {
  isVelocityLimitRejected,
  type createPurchaseVelocityLimiter,
} from './purchase-velocity-limiter.js';
import type { createEntitlementsService } from './entitlements.js';
import {
  assignCohort,
  applyPricingExperiment,
  type PricingExperimentConfig,
} from './pricing-experiments.js';

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

/**
 * Stripe checkout-session options shared by both flows (Epic 6.6, #102):
 * `automaticTax`/`taxIdCollectionEnabled` map directly to Stripe's own
 * `automatic_tax: { enabled }` / `tax_id_collection: { enabled }` session
 * params — automatic tax is what gives UK/EU buyers VAT-inclusive pricing
 * at checkout, and tax ID collection is the "capture a business VAT ID
 * when provided" criterion. `customerEmail` maps to Stripe's own
 * `customer_email`, which is also what drives Stripe's automatic receipt
 * email on successful payment — no separate "send a receipt" call is
 * needed once this is wired into a real `checkout.sessions.create`.
 */
export interface CreateOneOffCheckoutSessionInput {
  tierId: TierId;
  priceCents: number;
  userId: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  automaticTax: true;
  taxIdCollectionEnabled: true;
  /** The pricing-experiment cohort this session was created under (Epic 6.13, #110) — maps into Stripe's real `metadata.cohort`, alongside userId/tierId, so the checkout-completed webhook can read it back onto the entitlement grant and the purchase_completed analytics event. */
  cohort: string;
}

export interface CreateSubscriptionCheckoutSessionInput {
  tierId: TierId;
  priceCents: number;
  userId: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  automaticTax: true;
  taxIdCollectionEnabled: true;
  cohort: string;
}

/**
 * Thin wrapper over the real Stripe SDK (Epic 6.2) — swappable so every call
 * site here is unit-testable against a fake, same shape as
 * anthropic-client.ts/web-search.ts's client abstractions. The real
 * implementation (createStripeClient, not yet built — needs a live
 * STRIPE_SECRET_KEY to verify end-to-end, see PR description) wraps the
 * `stripe` npm package's `checkout.sessions.create` calls.
 */
export interface StripeClient {
  createOneOffCheckoutSession(
    input: CreateOneOffCheckoutSessionInput,
  ): Promise<StripeCheckoutSession>;
  createSubscriptionCheckoutSession(
    input: CreateSubscriptionCheckoutSessionInput,
  ): Promise<StripeCheckoutSession>;
}

/**
 * Fallback used when no STRIPE_SECRET_KEY is configured (build-app.ts) — errors
 * clearly on use rather than the server failing to boot, same convention as
 * web-search.ts's createUnconfiguredWebSearchClient. The real SDK-backed
 * client isn't built yet: it needs a live test-mode key to verify
 * checkout.sessions.create calls actually work end to end (see PR
 * description) and is deliberately left for whoever adds that key.
 */
export function createUnconfiguredStripeClient(): StripeClient {
  const reject = () =>
    Promise.reject(new Error('Stripe is not configured (missing STRIPE_SECRET_KEY)'));
  return {
    createOneOffCheckoutSession: reject,
    createSubscriptionCheckoutSession: reject,
  };
}

export interface CreateCheckoutSessionToolDeps {
  client: StripeClient;
  catalog: TierProduct[];
  /**
   * The disclaimer-acceptance gate (Epic 6.9, #105) — required so
   * financial-pack checkout can enforce "purchase possible only after
   * acceptance." Optional here (rather than required) only so existing
   * callers/tests for other tiers don't need to construct one when they
   * never exercise the gated path; build-app.ts always wires a real one.
   */
  disclaimerAcceptance?: ReturnType<typeof createDisclaimerAcceptanceService>;
  /**
   * Purchase velocity limit (Epic 6.10, #107) — optional for the same
   * reason as disclaimerAcceptance above (existing callers/tests for the
   * unlimited path don't need to construct one); build-app.ts always
   * wires a real one.
   */
  velocityLimiter?: ReturnType<typeof createPurchaseVelocityLimiter>;
  /**
   * Purchase-price history (Epic 6.13, #110's "purchasers always honoured
   * at purchase price") — optional for the same reason as the other
   * optional deps above; build-app.ts always wires a real one. Only ever
   * consulted for the resubscribable subscription tier (see
   * createCheckoutSession below) — a one-off tier can't be re-purchased
   * once owned, so there's no "different price on repurchase" scenario for
   * it to guard against.
   */
  entitlements?: ReturnType<typeof createEntitlementsService>;
  /**
   * Pricing-experiment config (Epic 6.13, #110) — optional; without one,
   * every user is assigned the implicit 'control' cohort and the base
   * catalog price/copy is used unchanged.
   */
  pricingExperiment?: PricingExperimentConfig;
}

export interface CreateCheckoutSessionInput {
  tierId: string;
  userId: string;
  /** The buyer's account email (Epic 6.6, #102) — passed through as Stripe's `customer_email`, which is also what drives Stripe's own automatic receipt-on-purchase email. Optional so a caller without it handy (e.g. a system-initiated session) doesn't need to look it up first. */
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
}

export type CheckoutSessionResult =
  | { ok: true; sessionId: string; url: string; cohort: string }
  | { ok: false; error: 'unknown_tier' }
  | { ok: false; error: 'disclaimer_not_accepted'; disclaimerId: string; version: string }
  | { ok: false; error: 'velocity_limit_exceeded'; retryAfterMs: number }
  | { ok: false; error: 'checkout_session_failed'; details: string };

/**
 * Explicit type guard rather than relying on inline `!result.ok` narrowing —
 * this pattern has caused a Vercel-only build failure multiple times this
 * project even when local tsc is clean on the same TypeScript version.
 */
export function isCheckoutSessionFailure(
  result: CheckoutSessionResult,
): result is Extract<CheckoutSessionResult, { ok: false }> {
  return result.ok === false;
}

/**
 * Checkout-session creation (Epic 6.2): routes each tier to the right Stripe
 * flow — the app-refinement top-up is the only subscription-billed tier
 * (tier-catalog.ts), everything else is a one-off purchase. Never trusts a
 * client-supplied price; always looks the tier's price up from the shared
 * catalog (#97) so a request can't smuggle in an arbitrary amount.
 */
export function createCheckoutSessionTool(deps: CreateCheckoutSessionToolDeps) {
  const {
    client,
    catalog,
    disclaimerAcceptance,
    velocityLimiter,
    entitlements,
    pricingExperiment,
  } = deps;

  async function createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionResult> {
    if (!isTierId(input.tierId)) {
      return { ok: false, error: 'unknown_tier' };
    }

    // Pricing experiment (Epic 6.13, #110): a deterministic per-user
    // cohort, applied on top of the base catalog before any further gate
    // or price logic runs — every downstream check (disclaimer,
    // price-honor guardrail, the real Stripe call) sees the cohort-adjusted
    // catalog, never the raw one.
    const cohort = pricingExperiment ? assignCohort(input.userId, pricingExperiment) : 'control';
    const effectiveCatalog = pricingExperiment
      ? applyPricingExperiment(catalog, cohort, pricingExperiment)
      : catalog;

    const product = effectiveCatalog.find((p) => p.id === input.tierId);
    if (!product) {
      return { ok: false, error: 'unknown_tier' };
    }

    // Purchase velocity limit (Epic 6.10, #107): checked before the
    // disclaimer gate and the real Stripe call — a scripted card-testing
    // pattern should be stopped as early as possible, regardless of tier.
    if (velocityLimiter) {
      const velocity = velocityLimiter.check(input.userId);
      if (isVelocityLimitRejected(velocity)) {
        return { ok: false, error: 'velocity_limit_exceeded', retryAfterMs: velocity.retryAfterMs };
      }
    }

    // Financial pack assumptions/not-advice gate (Epic 6.9, #105): the
    // only tier this applies to — never invented for any other product.
    if (product.id === 'financial-pack' && disclaimerAcceptance) {
      const accepted = await disclaimerAcceptance.hasAccepted(
        input.userId,
        FINANCIAL_PACK_DISCLAIMER_ID,
        FINANCIAL_PACK_DISCLAIMER_VERSION,
      );
      if (!accepted) {
        return {
          ok: false,
          error: 'disclaimer_not_accepted',
          disclaimerId: FINANCIAL_PACK_DISCLAIMER_ID,
          version: FINANCIAL_PACK_DISCLAIMER_VERSION,
        };
      }
    }

    // Purchase-price guardrail (Epic 6.13, #110): the only resubscribable
    // tier honors a returning user's original price rather than whatever a
    // pricing experiment currently shows — a one-off tier can never be
    // "re-purchased" once owned, so this never applies to one.
    let priceCents = product.priceCents;
    if (product.billingModel === 'subscription' && entitlements) {
      const historicalPrice = await entitlements.findHistoricalPriceCents(input.userId, product.id);
      if (historicalPrice !== null) {
        priceCents = historicalPrice;
      }
    }

    const sessionInput = {
      tierId: product.id,
      priceCents,
      userId: input.userId,
      customerEmail: input.customerEmail,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      cohort,
      automaticTax: true as const,
      taxIdCollectionEnabled: true as const,
    };

    try {
      const session =
        product.billingModel === 'subscription'
          ? await client.createSubscriptionCheckoutSession(sessionInput)
          : await client.createOneOffCheckoutSession(sessionInput);

      return { ok: true, sessionId: session.id, url: session.url, cohort };
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      return { ok: false, error: 'checkout_session_failed', details };
    }
  }

  return { createCheckoutSession };
}
