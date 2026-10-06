import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './auth.js';
import { registerSessionRoutes, isCardTamperAttempt } from './session.js';
import { createInMemoryAuthStore } from '../auth/auth-store.js';
import { createInMemorySessionStore } from '../session-store.js';
import { createInMemoryManifestStore } from '../manifest-store.js';
import type { BuildManifest } from '@forge/shared';

const MANIFEST: BuildManifest = {
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

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();
  const sessionStore = createInMemorySessionStore();
  const manifestStore = createInMemoryManifestStore();
  registerAuthRoutes(app, authStore);
  registerSessionRoutes(app, authStore, sessionStore, { app: 3, marketing: 3 }, manifestStore);
  await app.ready();
  return { app, authStore, sessionStore, manifestStore };
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

describe('isCardTamperAttempt (#92)', () => {
  it('flags a request body that includes a cards field', () => {
    expect(isCardTamperAttempt({ phase: 'build', cards: [{ id: 'fake' }] })).toBe(true);
    expect(isCardTamperAttempt({ cards: [] })).toBe(true);
  });

  it('does not flag a legitimate body with no cards field', () => {
    expect(isCardTamperAttempt({ phase: 'build' })).toBe(false);
    expect(isCardTamperAttempt({ chat: [{ role: 'user', text: 'hi' }] })).toBe(false);
    expect(isCardTamperAttempt({})).toBe(false);
  });

  it('handles non-object bodies safely', () => {
    expect(isCardTamperAttempt(null)).toBe(false);
    expect(isCardTamperAttempt(undefined)).toBe(false);
    expect(isCardTamperAttempt('cards')).toBe(false);
  });
});

describe('POST /api/sessions', () => {
  it('rejects an anonymous request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('creates a session tied to the authenticated user', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ phase: 'onboarding', chat: [], cards: [] });
    expect(body.userId).toEqual(expect.any(String));
    await app.close();
  });

  it('includes the configured refinement limits so the client can render a live meter (#86)', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });

    expect(res.json()).toMatchObject({
      appRefinementRounds: 0,
      marketingRefinementRounds: 0,
      refinementLimits: { app: 3, marketing: 3 },
    });
    await app.close();
  });
});

describe('GET /api/sessions/latest', () => {
  it('returns null when the user has no sessions yet', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/latest',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    await app.close();
  });

  it('returns the correct phase to resume on', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'sources' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/latest',
      headers: { cookie: authCookie },
    });

    expect(res.json()).toMatchObject({ id: sessionId, phase: 'sources' });
    await app.close();
  });

  it('includes refinementLimits on resume (#86)', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/latest',
      headers: { cookie: authCookie },
    });

    expect(res.json()).toMatchObject({ refinementLimits: { app: 3, marketing: 3 } });
    await app.close();
  });

  it('includes chatMessageCount so the client can tell a real conversation has started even before phase advances', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: {
        chat: [
          { id: '1', role: 'user', text: 'hi' },
          { id: '2', role: 'agent', text: 'hello' },
        ],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/latest',
      headers: { cookie: authCookie },
    });

    expect(res.json()).toMatchObject({ phase: 'onboarding', chatMessageCount: 2 });
    await app.close();
  });
});

describe('GET /api/sessions (project list)', () => {
  it('rejects an anonymous request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns an empty list for a user with no sessions yet', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('lists every session for the authenticated user, most recently updated first', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    // Touch the first session so it becomes the most recently updated.
    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${first.json().id}`,
      headers: { cookie: authCookie },
      payload: { chat: [{ role: 'user', text: 'hi' }] },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    const ids = res.json().map((s: { id: string }) => s.id);
    expect(ids).toEqual([first.json().id, second.json().id]);
  });

  it("never returns another user's sessions", async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie: authCookie } });

    const otherCookie = await signUpAndGetCookie(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: otherCookie },
    });

    expect(res.json()).toEqual([]);
    await app.close();
  });
});

describe('GET /api/sessions/:id', () => {
  it('restores phase, chat, and cards for the owning user', async () => {
    const { app, sessionStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'sources', chat: [{ role: 'user', text: 'hi' }] },
    });
    // Cards are never client-writable via this route (#92) — seed directly
    // via the store, matching how a real render_* tool would have written
    // them, to confirm GET genuinely restores server-persisted cards.
    await sessionStore.update(sessionId, {
      cards: [{ id: 'c1', type: 'options', status: 'draft' }],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      phase: 'sources',
      chat: [{ role: 'user', text: 'hi' }],
      cards: [{ id: 'c1', type: 'options', status: 'draft' }],
    });
    await app.close();
  });

  it('404s when the session belongs to a different user', async () => {
    const { app } = await buildTestApp();
    const ownerCookie = await signUpAndGetCookie(app);
    const otherCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: ownerCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: otherCookie },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404s for a nonexistent session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('PATCH /api/sessions/:id', () => {
  it('rejects an invalid phase value', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'not-a-real-phase' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects skipping ahead more than one phase (phase state machine, #28)', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'planning' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'illegal_phase_transition',
      from: 'onboarding',
      to: 'planning',
    });
    await app.close();
  });

  it('allows a legal single-step phase advance and persists it', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'sources' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ phase: 'sources' });
    await app.close();
  });

  it('allows updating chat/cards without a phase change', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { chat: [{ role: 'user', text: 'hi' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ phase: 'onboarding', chat: [{ role: 'user', text: 'hi' }] });
    await app.close();
  });

  it("rejects patching another user's session", async () => {
    const { app } = await buildTestApp();
    const ownerCookie = await signUpAndGetCookie(app);
    const otherCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: ownerCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: otherCookie },
      payload: { phase: 'sources' },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('blocks entering build without the four required cards locked (phase gate, #29)', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    // Walk to `planning`, the phase immediately before `build`.
    for (const phase of ['sources', 'brainstorm', 'planning']) {
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { cookie: authCookie },
        payload: { phase },
      });
    }

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'build' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'phase_gate_not_satisfied',
      to: 'build',
      missing: expect.arrayContaining(['options', 'architecture', 'cost', 'marketing']),
    });
    await app.close();
  });

  it('allows entering build once all four required cards are genuinely locked server-side', async () => {
    const { app, sessionStore, manifestStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    for (const phase of ['sources', 'brainstorm', 'planning']) {
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { cookie: authCookie },
        payload: { phase },
      });
    }

    // Simulates what the real render_* tools persist once the user locks
    // each card (e.g. lock_architecture, select_marketing_plan) — writing
    // directly to the store rather than through the client-facing PATCH,
    // since #92 requires the gate to trust only genuinely server-persisted
    // card state, never a client-supplied `cards` payload.
    const lockedCards = ['options', 'architecture', 'cost', 'marketing'].map((type) => ({
      id: `${type}-1`,
      type,
      status: 'locked',
    }));
    await sessionStore.update(sessionId, { cards: lockedCards });
    await manifestStore.save(sessionId, MANIFEST);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'build' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ phase: 'build' });
    // Confirming the build from the UI must freeze the manifest exactly like
    // the agent's transition_phase tool does — otherwise the build route
    // refuses with manifest_not_frozen (found in the production e2e run).
    expect((await sessionStore.get(sessionId))!.frozenManifestVersion).toBe(1);
    await app.close();
  });

  it('refuses to enter build when there is no manifest to freeze, leaving the phase unchanged', async () => {
    const { app, sessionStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id as string;
    for (const phase of ['sources', 'brainstorm', 'planning']) {
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { cookie: authCookie },
        payload: { phase },
      });
    }
    await sessionStore.update(sessionId, {
      cards: ['options', 'architecture', 'cost', 'marketing'].map((type) => ({
        id: `${type}-1`,
        type,
        status: 'locked',
      })),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'build' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'no_manifest_to_freeze' });
    expect((await sessionStore.get(sessionId))!.phase).toBe('planning');
    await app.close();
  });

  it("never trusts client-supplied cards to satisfy the build gate — only the session's own real cards count (#92)", async () => {
    // Regression coverage for a real tamper vector: a client could PATCH
    // { phase: 'build', cards: [...fabricated locked cards...] } in one
    // request and pass the gate without ever actually locking anything
    // server-side (no card was ever created via render_build_options,
    // lock_architecture, etc.) — the gate check must only ever evaluate the
    // session's own persisted cards, never a value the client just sent.
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    for (const phase of ['sources', 'brainstorm', 'planning']) {
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { cookie: authCookie },
        payload: { phase },
      });
    }

    const fabricatedLockedCards = ['options', 'architecture', 'cost', 'marketing'].map((type) => ({
      id: `fake-${type}`,
      type,
      status: 'locked',
    }));

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'build', cards: fabricatedLockedCards },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'phase_gate_not_satisfied',
      to: 'build',
      missing: expect.arrayContaining(['options', 'architecture', 'cost', 'marketing']),
    });
    await app.close();
  });
});

describe('GET /api/sessions/:id/gate', () => {
  it('reports the build gate as not passed with missing card types', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    for (const phase of ['sources', 'brainstorm', 'planning']) {
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { cookie: authCookie },
        payload: { phase },
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/gate`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      next: 'build',
      passed: false,
      missing: expect.arrayContaining(['options', 'architecture', 'cost', 'marketing']),
    });
    await app.close();
  });

  it('reports the gate as passed once cards are locked, without mutating the session', async () => {
    const { app, sessionStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const lockedCards = ['options', 'architecture', 'cost', 'marketing'].map((type) => ({
      id: `${type}-1`,
      type,
      status: 'locked',
    }));

    for (const phase of ['sources', 'brainstorm', 'planning']) {
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { cookie: authCookie },
        payload: { phase },
      });
    }
    // Seeded directly (#92: cards are never client-writable via PATCH),
    // matching what a real render_* tool would have persisted.
    await sessionStore.update(sessionId, { cards: lockedCards });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/gate`,
      headers: { cookie: authCookie },
    });

    expect(res.json()).toMatchObject({ next: 'build', passed: true, missing: [] });

    const stillPlanning = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
    });
    expect(stillPlanning.json()).toMatchObject({ phase: 'planning' });
    await app.close();
  });

  it('reports passed with no next phase for the terminal phase', async () => {
    const { app, sessionStore, manifestStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const lockedCards = ['options', 'architecture', 'cost', 'marketing'].map((type) => ({
      id: `${type}-1`,
      type,
      status: 'locked',
    }));
    for (const phase of ['sources', 'brainstorm', 'planning']) {
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        headers: { cookie: authCookie },
        payload: { phase },
      });
    }
    // Seeded directly (#92: cards are never client-writable via PATCH).
    await sessionStore.update(sessionId, { cards: lockedCards });
    await manifestStore.save(sessionId, MANIFEST);
    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'build' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
      payload: { phase: 'refine' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/gate`,
      headers: { cookie: authCookie },
    });

    expect(res.json()).toMatchObject({ next: null, passed: true, missing: [] });
    await app.close();
  });
});

describe('POST /api/sessions/:id/refine', () => {
  it('records a round and returns the updated count', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine`,
      headers: { cookie: authCookie },
      payload: { kind: 'app' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, rounds: 1, limitReached: false });
  });

  it('tracks app and marketing rounds independently via the route', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine`,
      headers: { cookie: authCookie },
      payload: { kind: 'app' },
    });
    const marketingRes = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine`,
      headers: { cookie: authCookie },
      payload: { kind: 'marketing' },
    });

    expect(marketingRes.json()).toMatchObject({ ok: true, rounds: 1 });

    const session = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: authCookie },
    });
    expect(session.json()).toMatchObject({ appRefinementRounds: 1, marketingRefinementRounds: 1 });
  });

  it('returns 429 with a gate signal once the free limit is reached', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/refine`,
        headers: { cookie: authCookie },
        payload: { kind: 'app' },
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine`,
      headers: { cookie: authCookie },
      payload: { kind: 'app' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'refinement_limit_reached', kind: 'app', rounds: 3 });
  });

  it('emits a refinement_used analytics event on success (#42)', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const infoSpy = vi.spyOn(app.log, 'info');

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine`,
      headers: { cookie: authCookie },
      payload: { kind: 'app' },
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        analytics_event: true,
        type: 'refinement_used',
        sessionId,
        kind: 'app',
        round: 1,
        limit: 3,
      }),
      'analytics.refinement_used',
    );
  });

  it('rejects an invalid kind', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine`,
      headers: { cookie: authCookie },
      payload: { kind: 'not-a-real-kind' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('404s when the session belongs to a different user', async () => {
    const { app } = await buildTestApp();
    const ownerCookie = await signUpAndGetCookie(app);
    const otherCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: ownerCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine`,
      headers: { cookie: otherCookie },
      payload: { kind: 'app' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/sessions/:id/brainstorm', () => {
  it('merges a single finding and reports the stopping rule as not satisfied', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}/brainstorm`,
      headers: { cookie: authCookie },
      payload: { icp: 'independent hairdressers' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      findings: { icp: 'independent hairdressers' },
      satisfied: false,
      missing: ['coreJob', 'differentiator'],
    });
  });

  it('accumulates findings across multiple calls without wiping prior ones', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}/brainstorm`,
      headers: { cookie: authCookie },
      payload: { icp: 'independent hairdressers' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}/brainstorm`,
      headers: { cookie: authCookie },
      payload: { coreJob: 'manage bookings without a receptionist' },
    });

    expect(res.json()).toMatchObject({
      findings: {
        icp: 'independent hairdressers',
        coreJob: 'manage bookings without a receptionist',
      },
      satisfied: false,
      missing: ['differentiator'],
    });
  });

  it('reports satisfied once all three findings are captured', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}/brainstorm`,
      headers: { cookie: authCookie },
      payload: {
        icp: 'independent hairdressers',
        coreJob: 'manage bookings without a receptionist',
        differentiator: 'built for solo operators, not salons',
      },
    });

    expect(res.json()).toMatchObject({ satisfied: true, missing: [] });
  });

  it('rejects an empty-string finding', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}/brainstorm`,
      headers: { cookie: authCookie },
      payload: { icp: '' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('404s when the session belongs to a different user', async () => {
    const { app } = await buildTestApp();
    const ownerCookie = await signUpAndGetCookie(app);
    const otherCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: ownerCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}/brainstorm`,
      headers: { cookie: otherCookie },
      payload: { icp: 'anyone' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/sessions/:id/brainstorm', () => {
  it('returns the current findings and stopping-rule status without mutating anything', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}/brainstorm`,
      headers: { cookie: authCookie },
      payload: { icp: 'independent hairdressers' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/brainstorm`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      findings: { icp: 'independent hairdressers' },
      satisfied: false,
      missing: ['coreJob', 'differentiator'],
    });
  });

  it('returns empty findings and full missing list for a fresh session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/brainstorm`,
      headers: { cookie: authCookie },
    });

    expect(res.json()).toMatchObject({
      findings: {},
      satisfied: false,
      missing: ['icp', 'coreJob', 'differentiator'],
    });
  });
});

describe('GET /api/sessions/:id/sources', () => {
  it('returns empty sources and incomplete status for a fresh session', async () => {
    const { app } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/sources`,
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sources: [], declined: false, complete: false });
  });

  it('404s when the session belongs to a different user', async () => {
    const { app } = await buildTestApp();
    const ownerCookie = await signUpAndGetCookie(app);
    const otherCookie = await signUpAndGetCookie(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: ownerCookie },
    });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/sources`,
      headers: { cookie: otherCookie },
    });

    expect(res.statusCode).toBe(404);
  });
});
