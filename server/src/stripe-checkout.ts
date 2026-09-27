import { isTierId, type TierId, type TierProduct } from './tier-catalog.js';
import type { createDisclaimerAcceptanceService } from './disclaimer-acceptance.js';
import {
  FINANCIAL_PACK_DISCLAIMER_ID,
  FINANCIAL_PACK_DISCLAIMER_VERSION,
} from './financial-pack-disclaimer.js';

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
  | { ok: true; sessionId: string; url: string }
  | { ok: false; error: 'unknown_tier' }
  | { ok: false; error: 'disclaimer_not_accepted'; disclaimerId: string; version: string }
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
  const { client, catalog, disclaimerAcceptance } = deps;

  async function createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionResult> {
    if (!isTierId(input.tierId)) {
      return { ok: false, error: 'unknown_tier' };
    }

    const product = catalog.find((p) => p.id === input.tierId);
    if (!product) {
      return { ok: false, error: 'unknown_tier' };
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

    const sessionInput = {
      tierId: product.id,
      priceCents: product.priceCents,
      userId: input.userId,
      customerEmail: input.customerEmail,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      automaticTax: true as const,
      taxIdCollectionEnabled: true as const,
    };

    try {
      const session =
        product.billingModel === 'subscription'
          ? await client.createSubscriptionCheckoutSession(sessionInput)
          : await client.createOneOffCheckoutSession(sessionInput);

      return { ok: true, sessionId: session.id, url: session.url };
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      return { ok: false, error: 'checkout_session_failed', details };
    }
  }

  return { createCheckoutSession };
}
