import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerSessionRoutes } from './session.js';
import { registerExportRoutes } from './export.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';
import { createInMemorySessionStore } from '../session-store.js';
import { createInMemoryManifestStore } from '../manifest-store.js';
import { createInMemoryArtifactStore } from '../artifact-store.js';

const CODE = 'export default function App() { return null; }';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();
  const sessionStore = createInMemorySessionStore();
  const manifestStore = createInMemoryManifestStore();
  const artifactStore = createInMemoryArtifactStore();
  const analyticsLogger = silentLogger();

  registerAuthRoutes(app, authStore);
  registerSessionRoutes(app, authStore, sessionStore, { app: 3, marketing: 3 }, manifestStore);
  registerExportRoutes(
    app,
    authStore,
    sessionStore,
    manifestStore,
    artifactStore,
    analyticsLogger,
    { app: 3, marketing: 3 },
  );
  await app.ready();
  return { app, sessionStore, manifestStore, artifactStore, analyticsLogger };
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

describe('GET /api/sessions/:id/export', () => {
  it('rejects an anonymous request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/whatever/export' });
    expect(res.statusCode).toBe(401);
  });

  it('404s for a nonexistent session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/export',
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
      method: 'GET',
      url: `/api/sessions/${sessionId}/export`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when there is no build to export yet', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/export`,
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'no_build_to_export' });
  });

  it('downloads the active build as a .jsx file and tracks the export', async () => {
    const { app, sessionStore, artifactStore, analyticsLogger } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    await artifactStore.save(sessionId, 'app', { manifestId: 'm1', content: { code: CODE } });
    await sessionStore.update(sessionId, { activeAppVersion: 1 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/export`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.jsx');
    expect(res.body).toContain(CODE);
    expect(analyticsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        analytics_event: true,
        type: 'app_exported',
        sessionId,
        version: 1,
        fromGate: false,
      }),
      'analytics.app_exported',
    );
  });

  it('tags the export event with fromGate:true when the app round limit was already reached (#95)', async () => {
    const { app, sessionStore, artifactStore, analyticsLogger } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    await artifactStore.save(sessionId, 'app', { manifestId: 'm1', content: { code: CODE } });
    await sessionStore.update(sessionId, { activeAppVersion: 1, appRefinementRounds: 3 });

    await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/export`,
      headers: { cookie: authCookie },
    });

    expect(analyticsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        analytics_event: true,
        type: 'app_exported',
        sessionId,
        version: 1,
        fromGate: true,
      }),
      'analytics.app_exported',
    );
  });

  it('includes the real product name from the manifest in the README header', async () => {
    const { app, sessionStore, manifestStore, artifactStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    await manifestStore.save(sessionId, {
      schemaVersion: 1,
      productName: 'HabitLoop',
      icp: 'people building daily habits',
      entities: [{ name: 'Habit', fields: [{ name: 'title', type: 'string' }] }],
      screens: [{ name: 'Habit list', purpose: 'see all habits' }],
      roles: ['user'],
      keyActions: ['create habit'],
      branding: { accentColor: '#2E7D32', tone: 'encouraging' },
      references: { researchCardIds: [] },
    });
    await artifactStore.save(sessionId, 'app', { manifestId: 'm1', content: { code: CODE } });
    await sessionStore.update(sessionId, { activeAppVersion: 1 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/export`,
      headers: { cookie: authCookie },
    });

    expect(res.body).toContain('HabitLoop');
  });
});

describe('GET /api/sessions/:id/export/summary', () => {
  it('rejects an anonymous request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/whatever/export/summary' });
    expect(res.statusCode).toBe(401);
  });

  it('404s for a nonexistent session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/export/summary',
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when there is no plan to summarize yet', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/export/summary`,
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'no_plan_to_summarize' });
  });

  it('downloads the plan summary as a text file, available even without a build (#93)', async () => {
    const { app, manifestStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    await manifestStore.save(sessionId, {
      schemaVersion: 1,
      productName: 'HabitLoop',
      icp: 'people building daily habits',
      entities: [{ name: 'Habit', fields: [{ name: 'title', type: 'string' }] }],
      screens: [{ name: 'Habit list', purpose: 'see all habits' }],
      roles: ['user'],
      keyActions: ['create habit'],
      branding: { accentColor: '#2E7D32', tone: 'encouraging' },
      references: { researchCardIds: [] },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/export/summary`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toContain('HabitLoop');
    expect(res.body).toContain('Habit');
    expect(res.body.toLowerCase()).toContain('forgethatidea.com');
  });
});
