import { describe, it, expect, vi } from 'vitest';
import {
  createCheckoutSessionTool,
  isCheckoutSessionFailure,
  type StripeClient,
} from './stripe-checkout.js';
import { getTierCatalog } from './tier-catalog.js';
import { loadEnv } from './env.js';
import {
  createDisclaimerAcceptanceService,
  createInMemoryDisclaimerAcceptanceStore,
} from './disclaimer-acceptance.js';
import {
  FINANCIAL_PACK_DISCLAIMER_ID,
  FINANCIAL_PACK_DISCLAIMER_VERSION,
} from './financial-pack-disclaimer.js';
import { createPurchaseVelocityLimiter } from './purchase-velocity-limiter.js';
import { createEntitlementsService, createInMemoryEntitlementStore } from './entitlements.js';
import type { PricingExperimentConfig } from './pricing-experiments.js';

function fakeStripeClient(overrides: Partial<StripeClient> = {}): StripeClient {
  return {
    createOneOffCheckoutSession: vi.fn(async ({ tierId }) => ({
      id: `cs_test_${tierId}`,
      url: `https://checkout.stripe.com/test/${tierId}`,
    })),
    createSubscriptionCheckoutSession: vi.fn(async ({ tierId }) => ({
      id: `cs_test_${tierId}`,
      url: `https://checkout.stripe.com/test/${tierId}`,
    })),
    ...overrides,
  };
}

const env = loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const catalog = getTierCatalog(env);

function disclaimerService() {
  const store = createInMemoryDisclaimerAcceptanceStore();
  return createDisclaimerAcceptanceService({ store });
}

describe('createCheckoutSessionTool (#98)', () => {
  it('creates a one-off checkout session for a one-off tier', async () => {
    const client = fakeStripeClient();
    const tool = createCheckoutSessionTool({ client, catalog });

    const result = await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      customerEmail: 'buyer@example.com',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(result).toMatchObject({
      ok: true,
      sessionId: 'cs_test_spec-pack',
      url: 'https://checkout.stripe.com/test/spec-pack',
    });
    expect(client.createOneOffCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tierId: 'spec-pack',
        priceCents: catalog.find((p) => p.id === 'spec-pack')!.priceCents,
        userId: 'user-1',
        customerEmail: 'buyer@example.com',
        successUrl: 'https://forge.test/success',
        cancelUrl: 'https://forge.test/cancel',
        // Stripe checkout-session options (#102): automatic tax + VAT ID
        // collection so UK/EU buyers see VAT-inclusive pricing and can
        // supply a business VAT ID, and a receipt is emailed automatically
        // to customerEmail — real behavior only takes effect once the real
        // SDK-backed StripeClient (still deferred, no live key) actually
        // wraps these into stripe.checkout.sessions.create's real options.
        automaticTax: true,
        taxIdCollectionEnabled: true,
      }),
    );
    expect(client.createSubscriptionCheckoutSession).not.toHaveBeenCalled();
  });

  it('creates a checkout session without a customerEmail (optional)', async () => {
    const client = fakeStripeClient();
    const tool = createCheckoutSessionTool({ client, catalog });

    const result = await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(result.ok).toBe(true);
    expect(client.createOneOffCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerEmail: undefined }),
    );
  });

  it('creates a subscription checkout session for the subscription tier', async () => {
    const client = fakeStripeClient();
    const tool = createCheckoutSessionTool({ client, catalog });

    const result = await tool.createCheckoutSession({
      tierId: 'app-refinement-topup',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(result).toMatchObject({ ok: true, sessionId: 'cs_test_app-refinement-topup' });
    expect(client.createSubscriptionCheckoutSession).toHaveBeenCalledOnce();
    expect(client.createOneOffCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects an unknown tier id', async () => {
    const client = fakeStripeClient();
    const tool = createCheckoutSessionTool({ client, catalog });

    const result = await tool.createCheckoutSession({
      tierId: 'not-a-real-tier',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(isCheckoutSessionFailure(result)).toBe(true);
    if (isCheckoutSessionFailure(result)) {
      expect(result.error).toBe('unknown_tier');
    }
    expect(client.createOneOffCheckoutSession).not.toHaveBeenCalled();
    expect(client.createSubscriptionCheckoutSession).not.toHaveBeenCalled();
  });

  it('surfaces a client-level failure as a typed result rather than throwing', async () => {
    const client = fakeStripeClient({
      createOneOffCheckoutSession: vi.fn(async () => {
        throw new Error('stripe API unreachable');
      }),
    });
    const tool = createCheckoutSessionTool({ client, catalog });

    const result = await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(isCheckoutSessionFailure(result)).toBe(true);
    if (isCheckoutSessionFailure(result)) {
      expect(result.error).toBe('checkout_session_failed');
    }
    if (isCheckoutSessionFailure(result) && result.error === 'checkout_session_failed') {
      expect(result.details).toContain('stripe API unreachable');
    }
  });

  it('rejects a financial-pack checkout when the user has not accepted the current disclaimer version (#105)', async () => {
    const client = fakeStripeClient();
    const disclaimerAcceptance = disclaimerService();
    const tool = createCheckoutSessionTool({ client, catalog, disclaimerAcceptance });

    const result = await tool.createCheckoutSession({
      tierId: 'financial-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(isCheckoutSessionFailure(result)).toBe(true);
    if (isCheckoutSessionFailure(result)) {
      expect(result.error).toBe('disclaimer_not_accepted');
    }
    expect(client.createOneOffCheckoutSession).not.toHaveBeenCalled();
  });

  it('allows a financial-pack checkout once the user has accepted the current disclaimer version', async () => {
    const client = fakeStripeClient();
    const disclaimerAcceptance = disclaimerService();
    await disclaimerAcceptance.recordAcceptance(
      'user-1',
      FINANCIAL_PACK_DISCLAIMER_ID,
      FINANCIAL_PACK_DISCLAIMER_VERSION,
    );
    const tool = createCheckoutSessionTool({ client, catalog, disclaimerAcceptance });

    const result = await tool.createCheckoutSession({
      tierId: 'financial-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(result.ok).toBe(true);
    expect(client.createOneOffCheckoutSession).toHaveBeenCalledOnce();
  });

  it('requires re-acceptance for financial-pack checkout after the disclaimer version changes', async () => {
    const client = fakeStripeClient();
    const disclaimerAcceptance = disclaimerService();
    await disclaimerAcceptance.recordAcceptance(
      'user-1',
      FINANCIAL_PACK_DISCLAIMER_ID,
      'stale-version',
    );
    const tool = createCheckoutSessionTool({ client, catalog, disclaimerAcceptance });

    const result = await tool.createCheckoutSession({
      tierId: 'financial-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(isCheckoutSessionFailure(result)).toBe(true);
    if (isCheckoutSessionFailure(result)) {
      expect(result.error).toBe('disclaimer_not_accepted');
    }
  });

  it('never gates other tiers behind the financial-pack disclaimer', async () => {
    const client = fakeStripeClient();
    const disclaimerAcceptance = disclaimerService();
    const tool = createCheckoutSessionTool({ client, catalog, disclaimerAcceptance });

    const result = await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a checkout attempt once the purchase velocity limit is exceeded (#107)', async () => {
    const client = fakeStripeClient();
    const velocityLimiter = createPurchaseVelocityLimiter({ maxAttempts: 1, windowMs: 60_000 });
    const tool = createCheckoutSessionTool({ client, catalog, velocityLimiter });

    await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });
    const result = await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(isCheckoutSessionFailure(result)).toBe(true);
    if (isCheckoutSessionFailure(result)) {
      expect(result.error).toBe('velocity_limit_exceeded');
    }
    expect(client.createOneOffCheckoutSession).toHaveBeenCalledOnce();
  });

  it('tracks the velocity limit independently per user', async () => {
    const client = fakeStripeClient();
    const velocityLimiter = createPurchaseVelocityLimiter({ maxAttempts: 1, windowMs: 60_000 });
    const tool = createCheckoutSessionTool({ client, catalog, velocityLimiter });

    await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });
    const result = await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-2',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(result.ok).toBe(true);
  });

  it('honors a previous purchase price for a resubscribe of the subscription tier (#110)', async () => {
    const client = fakeStripeClient();
    const entitlementStore = createInMemoryEntitlementStore();
    const entitlements = createEntitlementsService({ store: entitlementStore });
    await entitlements.grant('user-1', 'app-refinement-topup', {
      source: 'purchase',
      reference: 'sub_old',
      purchasePriceCents: 300,
    });
    const tool = createCheckoutSessionTool({ client, catalog, entitlements });

    await tool.createCheckoutSession({
      tierId: 'app-refinement-topup',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(client.createSubscriptionCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceCents: 300 }),
    );
  });

  it('uses the current catalog price for a first-time subscription purchase', async () => {
    const client = fakeStripeClient();
    const entitlementStore = createInMemoryEntitlementStore();
    const entitlements = createEntitlementsService({ store: entitlementStore });
    const tool = createCheckoutSessionTool({ client, catalog, entitlements });

    await tool.createCheckoutSession({
      tierId: 'app-refinement-topup',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    const currentPrice = catalog.find((p) => p.id === 'app-refinement-topup')!.priceCents;
    expect(client.createSubscriptionCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceCents: currentPrice }),
    );
  });

  it('never applies price history to a one-off tier', async () => {
    const client = fakeStripeClient();
    const entitlementStore = createInMemoryEntitlementStore();
    const entitlements = createEntitlementsService({ store: entitlementStore });
    // Simulate an (impossible in practice, but defensively tested) stale
    // history entry for a one-off tier — the guardrail only ever applies to
    // the resubscribable tier.
    await entitlements.grant('user-1', 'spec-pack', {
      source: 'purchase',
      reference: 'cs_old',
      purchasePriceCents: 1,
    });
    const tool = createCheckoutSessionTool({ client, catalog, entitlements });

    await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    const currentPrice = catalog.find((p) => p.id === 'spec-pack')!.priceCents;
    expect(client.createOneOffCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceCents: currentPrice }),
    );
  });

  it('applies the pricing-experiment cohort price and returns the assigned cohort in the result (#110)', async () => {
    const client = fakeStripeClient();
    const pricingExperiment: PricingExperimentConfig = {
      cohorts: ['only-cohort'],
      overrides: { 'only-cohort': { 'spec-pack': { priceCents: 990 } } },
    };
    const tool = createCheckoutSessionTool({ client, catalog, pricingExperiment });

    const result = await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(result).toMatchObject({ ok: true, cohort: 'only-cohort' });
    expect(client.createOneOffCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceCents: 990 }),
    );
  });

  it('defaults the cohort to "control" when no pricing experiment is configured', async () => {
    const client = fakeStripeClient();
    const tool = createCheckoutSessionTool({ client, catalog });

    const result = await tool.createCheckoutSession({
      tierId: 'spec-pack',
      userId: 'user-1',
      successUrl: 'https://forge.test/success',
      cancelUrl: 'https://forge.test/cancel',
    });

    expect(result).toMatchObject({ ok: true, cohort: 'control' });
  });
});
