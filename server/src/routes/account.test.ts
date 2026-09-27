import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerAccountRoutes } from './account.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';

function silentLogger() {
  return { info: vi.fn() };
}

async function buildTestApp(analyticsLogger = silentLogger()) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();

  registerAuthRoutes(app, authStore);
  registerAccountRoutes(app, authStore, analyticsLogger);

  await app.ready();
  return { app, analyticsLogger };
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

describe('account export-request route (#104)', () => {
  it('requires authentication', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/account/export-request' });

    expect(res.statusCode).toBe(401);
  });

  it('accepts the request and logs it durably, keyed by the requesting user', async () => {
    const analyticsLogger = silentLogger();
    const { app } = await buildTestApp(analyticsLogger);
    const { cookie: authCookie, userId } = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/account/export-request',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(analyticsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        analytics_event: true,
        type: 'data_export_requested',
        userId,
      }),
      'analytics.data_export_requested',
    );
  });
});
