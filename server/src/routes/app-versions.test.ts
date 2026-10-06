import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerSessionRoutes } from './session.js';
import { registerAppVersionsRoutes } from './app-versions.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';
import { createInMemorySessionStore } from '../session-store.js';
import { createInMemoryArtifactStore } from '../artifact-store.js';
import { createInMemoryManifestStore } from '../manifest-store.js';

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();
  const sessionStore = createInMemorySessionStore();
  const artifactStore = createInMemoryArtifactStore();

  registerAuthRoutes(app, authStore);
  registerSessionRoutes(
    app,
    authStore,
    sessionStore,
    { app: 3, marketing: 3 },
    createInMemoryManifestStore(),
  );
  registerAppVersionsRoutes(app, authStore, sessionStore, artifactStore);
  await app.ready();
  return { app, sessionStore, artifactStore };
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

describe('GET /api/sessions/:id/app/versions (#90)', () => {
  it('rejects an anonymous request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/whatever/app/versions' });
    expect(res.statusCode).toBe(401);
  });

  it('404s for a nonexistent session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/app/versions',
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists every version, newest first, with timestamp/summary and the active one flagged', async () => {
    const { app, sessionStore, artifactStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    await artifactStore.save(sessionId, 'app', {
      manifestId: 'm1',
      content: { code: 'v1 code', changeSummary: 'Initial build' },
    });
    await artifactStore.save(sessionId, 'app', {
      manifestId: 'm1',
      content: { code: 'v2 code', changeSummary: 'Make the header blue' },
    });
    await sessionStore.update(sessionId, { activeAppVersion: 2 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/app/versions`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeVersion).toBe(2);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0]).toMatchObject({ version: 2, changeSummary: 'Make the header blue' });
    expect(body.versions[1]).toMatchObject({ version: 1, changeSummary: 'Initial build' });
    expect(typeof body.versions[0].createdAt).toBe('string');
  });
});

describe('POST /api/sessions/:id/app/versions/:version/revert (#90)', () => {
  it('rejects an anonymous request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/whatever/app/versions/1/revert',
    });
    expect(res.statusCode).toBe(401);
  });

  it('404s for a nonexistent session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/app/versions/1/revert',
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s for an unknown version', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/app/versions/99/revert`,
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: 'version_not_found' });
  });

  it('reverts the active version without touching the refinement round counter', async () => {
    const { app, sessionStore, artifactStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    await artifactStore.save(sessionId, 'app', {
      manifestId: 'm1',
      content: { code: 'v1 code', changeSummary: 'Initial build' },
    });
    await artifactStore.save(sessionId, 'app', {
      manifestId: 'm1',
      content: { code: 'v2 code', changeSummary: 'Make the header blue' },
    });
    await sessionStore.update(sessionId, { activeAppVersion: 2, appRefinementRounds: 1 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/app/versions/1/revert`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe('v1 code');
    // 'v1 code' doesn't parse as JS — the fallback-to-raw-source path
    // (compileForPreview) kicks in rather than throwing.
    expect(res.json().compiledCode).toBe('v1 code');
    const updatedSession = await sessionStore.get(sessionId);
    expect(updatedSession?.activeAppVersion).toBe(1);
    expect(updatedSession?.appRefinementRounds).toBe(1);
  });

  it('returns the stored compiledCode for a version saved with one, rather than recompiling (#eval-csp-fix)', async () => {
    const { app, sessionStore, artifactStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    await artifactStore.save(sessionId, 'app', {
      manifestId: 'm1',
      content: {
        code: 'export default function App() { return null; }',
        compiledCode: 'var ForgeCompiledApp = {};',
        changeSummary: 'Initial build',
      },
    });
    await artifactStore.save(sessionId, 'app', {
      manifestId: 'm1',
      content: { code: 'v2 code', changeSummary: 'Make the header blue' },
    });
    await sessionStore.update(sessionId, { activeAppVersion: 2 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/app/versions/1/revert`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().compiledCode).toBe('var ForgeCompiledApp = {};');
  });
});
