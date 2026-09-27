import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerCheckoutRoutes } from './checkout.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';
import { createCheckoutSessionTool, type StripeClient } from '../stripe-checkout.js';
import { getTierCatalog } from '../tier-catalog.js';
import { loadEnv } from '../env.js';

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

async function buildTestApp(client: StripeClient = fakeStripeClient()) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();
  const env = loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const catalog = getTierCatalog(env);
  const checkoutTool = createCheckoutSessionTool({ client, catalog });

  registerAuthRoutes(app, authStore);
  registerCheckoutRoutes(app, authStore, checkoutTool);

  await app.ready();
  return { app };
}

function extractCookie(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = /^([^=]+=[^;]+)/.exec(String(raw));
  if (!match) throw new Error('no cookie in response');
  return match[1]!;
}

async function signUpAndGetCookie(
  app: Awaited<ReturnType<typeof buildTestApp>>['app'],
  email = `u${Math.random()}@example.com`,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password: 'correct horse battery staple' },
  });
  return extractCookie(res);
}

describe('checkout route (#98)', () => {
  it('requires authentication', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: {
        tierId: 'spec-pack',
        successUrl: 'https://forge.test/success',
        cancelUrl: 'https://forge.test/cancel',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('creates a checkout session for an authenticated user', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { cookie: authCookie },
      payload: {
        tierId: 'spec-pack',
        successUrl: 'https://forge.test/success',
        cancelUrl: 'https://forge.test/cancel',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      sessionId: 'cs_test_spec-pack',
      url: 'https://checkout.stripe.com/test/spec-pack',
    });
  });

  it("passes the signed-in user's own email through as customerEmail (drives Stripe's automatic receipt, #102)", async () => {
    const client = fakeStripeClient();
    const { app } = await buildTestApp(client);
    const authCookie = await signUpAndGetCookie(app, 'receipt-test@example.com');

    await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { cookie: authCookie },
      payload: {
        tierId: 'spec-pack',
        successUrl: 'https://forge.test/success',
        cancelUrl: 'https://forge.test/cancel',
      },
    });

    expect(client.createOneOffCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerEmail: 'receipt-test@example.com' }),
    );
  });

  it('rejects an unknown tier with 400', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { cookie: authCookie },
      payload: {
        tierId: 'not-a-real-tier',
        successUrl: 'https://forge.test/success',
        cancelUrl: 'https://forge.test/cancel',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: 'unknown_tier' });
  });

  it('rejects a missing body field with validation_failed', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { cookie: authCookie },
      payload: { tierId: 'spec-pack' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed' });
  });

  it('surfaces a Stripe-level failure as 502', async () => {
    const client = fakeStripeClient({
      createOneOffCheckoutSession: vi.fn(async () => {
        throw new Error('stripe API unreachable');
      }),
    });
    const { app } = await buildTestApp(client);
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { cookie: authCookie },
      payload: {
        tierId: 'spec-pack',
        successUrl: 'https://forge.test/success',
        cancelUrl: 'https://forge.test/cancel',
      },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ ok: false, error: 'checkout_session_failed' });
  });
});
