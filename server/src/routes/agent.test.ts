import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerSessionRoutes } from './session.js';
import { registerAgentRoutes } from './agent.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';
import { createInMemorySessionStore } from '../session-store.js';
import { createInMemoryManifestStore } from '../manifest-store.js';
import { createCostGuard, createInMemoryCostGuardStore } from '../cost-guard.js';
import { createAgentOrchestrator } from '../agent-orchestrator.js';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();
  const sessionStore = createInMemorySessionStore();
  const manifestStore = createInMemoryManifestStore();
  const costGuard = createCostGuard({
    store: createInMemoryCostGuardStore(),
    sessionCapCents: 1000,
    userDailyCapCents: 10000,
    warnRatio: 0.8,
    logger: silentLogger(),
  });
  const anthropicClient = {
    streamMessage: vi.fn(async () => ({
      inputTokens: 5,
      outputTokens: 3,
      stopReason: 'end_turn',
      content: [{ type: 'text' as const, text: 'Hi there!' }],
    })),
  };
  const orchestrator = createAgentOrchestrator({
    sessionStore,
    manifestStore,
    costGuard,
    anthropicClient,
  });

  registerAuthRoutes(app, authStore);
  // Session routes registered too, so tests can create a real session tied
  // to the signed-up user via the normal API rather than reaching into the
  // store directly with a made-up userId.
  registerSessionRoutes(app, authStore, sessionStore, { app: 3, marketing: 3 }, manifestStore);
  registerAgentRoutes(app, authStore, sessionStore, orchestrator);
  await app.ready();
  return { app, authStore, sessionStore, anthropicClient };
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
  return extractCookie(res);
}

async function createSessionAs(
  app: Awaited<ReturnType<typeof buildTestApp>>['app'],
  authCookie: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { cookie: authCookie },
  });
  return res.json().id;
}

describe('POST /api/sessions/:id/message', () => {
  it('rejects an anonymous request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/whatever/message',
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an empty message', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/message`,
      headers: { cookie: authCookie },
      payload: { text: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for a nonexistent session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/message',
      headers: { cookie: authCookie },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s when the session belongs to a different user', async () => {
    const { app } = await buildTestApp();
    const ownerCookie = await signUpAndGetCookie(app);
    const otherCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, ownerCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/message`,
      headers: { cookie: otherCookie },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the agent reply for a valid message from the owning user', async () => {
    const { app, anthropicClient } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/message`,
      headers: { cookie: authCookie },
      payload: { text: 'hello' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, reply: 'Hi there!', events: [] });
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
  });

  it('persists the exchange to session chat', async () => {
    const { app, sessionStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);

    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/message`,
      headers: { cookie: authCookie },
      payload: { text: 'hello' },
    });

    const session = await sessionStore.get(sessionId);
    expect(session!.chat).toEqual([
      expect.objectContaining({ role: 'user', text: 'hello' }),
      expect.objectContaining({ role: 'agent', text: 'Hi there!' }),
    ]);
  });
});
