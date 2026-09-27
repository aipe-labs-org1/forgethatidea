import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerDisclaimerAcceptanceRoutes } from './disclaimer-acceptance.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';
import {
  createDisclaimerAcceptanceService,
  createInMemoryDisclaimerAcceptanceStore,
} from '../disclaimer-acceptance.js';
import {
  FINANCIAL_PACK_DISCLAIMER_ID,
  FINANCIAL_PACK_DISCLAIMER_VERSION,
} from '../financial-pack-disclaimer.js';

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();
  const disclaimerAcceptance = createDisclaimerAcceptanceService({
    store: createInMemoryDisclaimerAcceptanceStore(),
  });

  registerAuthRoutes(app, authStore);
  registerDisclaimerAcceptanceRoutes(app, authStore, disclaimerAcceptance);

  await app.ready();
  return { app, disclaimerAcceptance };
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

describe('financial-pack disclaimer acceptance route (#105)', () => {
  it('requires authentication', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/disclaimers/financial-pack/accept',
    });

    expect(res.statusCode).toBe(401);
  });

  it('records acceptance for the signed-in user at the current disclaimer version', async () => {
    const { app, disclaimerAcceptance } = await buildTestApp();
    const { cookie: authCookie, userId } = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/disclaimers/financial-pack/accept',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, version: FINANCIAL_PACK_DISCLAIMER_VERSION });
    expect(
      await disclaimerAcceptance.hasAccepted(
        userId,
        FINANCIAL_PACK_DISCLAIMER_ID,
        FINANCIAL_PACK_DISCLAIMER_VERSION,
      ),
    ).toBe(true);
  });
});
