import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerSessionRoutes } from './session.js';
import { registerAppArtifactRoutes } from './app-artifact.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';
import { createInMemorySessionStore } from '../session-store.js';
import { createInMemoryArtifactStore } from '../artifact-store.js';
import { createInMemoryManifestStore } from '../manifest-store.js';

// Includes a minimal real error boundary (componentDidCatch) — required by
// the missing_error_boundary contract rule (#80) for code to count as valid.
const CODE =
  'class B extends React.Component { componentDidCatch(e) {} render() { return this.props.children; } } export default function App() { return null; }';

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
  registerAppArtifactRoutes(app, authStore, sessionStore, artifactStore);
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

describe('GET /api/sessions/:id/app (#94)', () => {
  it('rejects an anonymous request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/whatever/app' });
    expect(res.statusCode).toBe(401);
  });

  it('404s for a nonexistent session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/app',
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s for a session belonging to a different user', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    const otherCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/app`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when there is no active build yet', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/app`,
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'no_build_to_resume' });
  });

  it('returns the active app code, compiled JS, and version so a resumed session can re-render it', async () => {
    const { app, sessionStore, artifactStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    await artifactStore.save(sessionId, 'app', {
      manifestId: 'm1',
      content: { code: CODE, compiledCode: 'var ForgeCompiledApp = {};' },
    });
    await sessionStore.update(sessionId, { activeAppVersion: 1 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/app`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      code: CODE,
      compiledCode: 'var ForgeCompiledApp = {};',
      version: 1,
    });
  });

  it('compiles on the fly for a legacy artifact saved before compiledCode existed (#eval-csp-fix)', async () => {
    const { app, sessionStore, artifactStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);
    // Legacy shape: no compiledCode field at all.
    await artifactStore.save(sessionId, 'app', { manifestId: 'm1', content: { code: CODE } });
    await sessionStore.update(sessionId, { activeAppVersion: 1 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/app`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(CODE);
    expect(res.json().compiledCode).toContain('ForgeCompiledApp');
  });
});
