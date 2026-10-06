import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerSessionRoutes } from './session.js';
import { registerBuildRoutes } from './build.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';
import { createInMemorySessionStore } from '../session-store.js';
import { createInMemoryManifestStore } from '../manifest-store.js';
import { createInMemoryArtifactStore } from '../artifact-store.js';
import { createCostGuard, createInMemoryCostGuardStore } from '../cost-guard.js';
import { createBuildOrchestrator } from '../build-orchestrator.js';
import type { BuildManifest } from '@forge/shared';

// Includes a minimal real error boundary (componentDidCatch) — required by
// the missing_error_boundary contract rule (#80) for code to count as valid.
const VALID_CODE =
  'class B extends React.Component { componentDidCatch(e) {} render() { return this.props.children; } } export default function App() { return null; }';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function manifest(): BuildManifest {
  return {
    schemaVersion: 1,
    productName: 'HabitLoop',
    icp: 'people building daily habits',
    entities: [{ name: 'Habit', fields: [{ name: 'title', type: 'string' }] }],
    screens: [{ name: 'Habit list', purpose: 'see all habits' }],
    roles: ['user'],
    keyActions: ['create habit'],
    branding: { accentColor: '#2E7D32', tone: 'encouraging' },
    references: { researchCardIds: [] },
    archetype: 'crud-tracker',
  };
}

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();
  const sessionStore = createInMemorySessionStore();
  const manifestStore = createInMemoryManifestStore();
  const artifactStore = createInMemoryArtifactStore();
  const costGuard = createCostGuard({
    store: createInMemoryCostGuardStore(),
    sessionCapCents: 100_000,
    userDailyCapCents: 100_000,
    warnRatio: 0.8,
    logger: silentLogger(),
  });
  const anthropicClient = {
    streamMessage: vi.fn(async (_req: unknown, handlers: { onText?: (t: string) => void }) => {
      handlers.onText?.(VALID_CODE);
      return {
        inputTokens: 100,
        outputTokens: 200,
        stopReason: 'end_turn',
        content: [{ type: 'text' as const, text: VALID_CODE }],
      };
    }),
  };
  const orchestrator = createBuildOrchestrator({
    sessionStore,
    manifestStore,
    artifactStore,
    costGuard,
    anthropicClient,
  });

  registerAuthRoutes(app, authStore);
  registerSessionRoutes(app, authStore, sessionStore, { app: 3, marketing: 3 }, manifestStore);
  registerBuildRoutes(app, authStore, sessionStore, orchestrator);
  await app.ready();
  return { app, authStore, sessionStore, manifestStore, artifactStore, anthropicClient };
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

describe('POST /api/sessions/:id/build', () => {
  it('rejects an anonymous request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/whatever/build' });
    expect(res.statusCode).toBe(401);
  });

  it('404s for a nonexistent session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/build',
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s when the session belongs to a different user', async () => {
    const { app } = await buildTestApp();
    const ownerCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, ownerCookie);
    const otherCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/build`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the manifest has not been frozen yet', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/build`,
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'manifest_not_frozen' });
  });

  it('builds successfully once the manifest is frozen, returning the generated code', async () => {
    const { app, sessionStore, manifestStore, artifactStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    await manifestStore.save(sessionId, manifest());
    await sessionStore.update(sessionId, { frozenManifestVersion: 1, phase: 'build' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/build`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, code: VALID_CODE, version: 1 });
    const updatedSession = await sessionStore.get(sessionId);
    expect(updatedSession?.activeAppVersion).toBe(1);
    const artifact = await artifactStore.getVersion(sessionId, 'app', 1);
    expect(artifact?.content).toMatchObject({ code: VALID_CODE });
  });
});
