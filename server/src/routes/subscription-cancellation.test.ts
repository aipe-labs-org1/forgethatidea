import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerSubscriptionCancellationRoutes } from './subscription-cancellation.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';
import { createEntitlementsService, createInMemoryEntitlementStore } from '../entitlements.js';
import {
  createSubscriptionCancellationTool,
  type SubscriptionCancelClient,
} from '../subscription-cancellation.js';

function fakeClient(overrides: Partial<SubscriptionCancelClient> = {}): SubscriptionCancelClient {
  return {
    cancelSubscription: vi.fn(async () => ({ cancelAtPeriodEnd: true, currentPeriodEnd: 123 })),
    ...overrides,
  };
}

async function buildTestApp(client: SubscriptionCancelClient = fakeClient()) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();
  const entitlementStore = createInMemoryEntitlementStore();
  const entitlements = createEntitlementsService({ store: entitlementStore });
  const cancellationTool = createSubscriptionCancellationTool({ client, entitlements });

  registerAuthRoutes(app, authStore);
  registerSubscriptionCancellationRoutes(app, authStore, cancellationTool);

  await app.ready();
  return { app, entitlements };
}

function extractCookie(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = /^([^=]+=[^;]+)/.exec(String(raw));
  if (!match) throw new Error('no cookie in response');
  return match[1]!;
}

async function signUpAndGetCookie(app: Awaited<ReturnType<typeof buildTestApp>>['app']) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: `u${Math.random()}@example.com`, password: 'correct horse battery staple' },
  });
  return { cookie: extractCookie(res), userId: res.json().id as string };
}

describe('subscription cancellation route (#103)', () => {
  it('requires authentication', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/subscription/cancel' });

    expect(res.statusCode).toBe(401);
  });

  it('schedules a cancel-at-period-end for the signed-in user own subscription', async () => {
    const client = fakeClient();
    const { app, entitlements } = await buildTestApp(client);
    const { cookie: authCookie, userId } = await signUpAndGetCookie(app);
    await entitlements.grant(userId, 'app-refinement-topup', {
      source: 'purchase',
      reference: 'sub_abc123',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/subscription/cancel',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, cancelAtPeriodEnd: true });
    expect(client.cancelSubscription).toHaveBeenCalledWith('sub_abc123');
  });

  it('returns 404 when the user has no active subscription', async () => {
    const { app } = await buildTestApp();
    const { cookie: authCookie } = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/subscription/cancel',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, error: 'no_active_subscription' });
  });
});
