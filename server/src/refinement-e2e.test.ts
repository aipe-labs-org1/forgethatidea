import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerRefineAppRoutes } from './routes/refine-app.js';
import { registerExportRoutes } from './routes/export.js';
import { registerCardSelectionRoutes } from './routes/card-selection.js';
import { createInMemoryAuthStore } from './auth/auth-store.js';
import { createInMemorySessionStore } from './session-store.js';
import { createInMemoryArtifactStore } from './artifact-store.js';
import { createInMemoryManifestStore } from './manifest-store.js';
import { createRefineAppOrchestrator } from './refine-app-orchestrator.js';
import { createMarketingRefinementTool } from './marketing-refinement.js';
import { createRenderMarketingPlansTool } from './render-marketing-plans-tool.js';

const EDITED_CODE =
  'class B extends React.Component { componentDidCatch(e) {} render() { return this.props.children; } } export default function App() { return <div>Edited</div>; }';

const PLAN = {
  name: 'Community-led growth',
  icp: 'Solo founders validating an idea',
  gtm: 'Launch in indie-hacker communities',
  seo: 'Long-tail "idea to app" content',
  ads: 'Small retargeting budget',
  competitors: ['Bubble'],
};
const PLANS_INPUT = {
  plans: [PLAN, { ...PLAN, name: 'Plan B' }, { ...PLAN, name: 'Plan C' }],
};

function clientReturning(code: string) {
  return {
    streamMessage: vi.fn(async (_req: unknown, handlers: { onText?: (t: string) => void }) => {
      handlers.onText?.(code);
      return {
        inputTokens: 10,
        outputTokens: 20,
        stopReason: 'end_turn',
        content: [{ type: 'text' as const, text: code }],
      };
    }),
  };
}

const REFINEMENT_LIMITS = { app: 2, marketing: 2 };

async function buildTestApp() {
  const analyticsLogger = { info: vi.fn() };
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const authStore = createInMemoryAuthStore();
  const sessionStore = createInMemorySessionStore();
  const artifactStore = createInMemoryArtifactStore();
  const manifestStore = createInMemoryManifestStore();
  const anthropicClient = clientReturning(EDITED_CODE);
  const refineAppOrchestrator = createRefineAppOrchestrator({
    sessionStore,
    artifactStore,
    anthropicClient,
    refinementLimits: REFINEMENT_LIMITS,
  });

  registerAuthRoutes(app, authStore);
  registerSessionRoutes(app, authStore, sessionStore, REFINEMENT_LIMITS, manifestStore);
  registerRefineAppRoutes(app, authStore, sessionStore, refineAppOrchestrator, analyticsLogger);
  registerExportRoutes(
    app,
    authStore,
    sessionStore,
    manifestStore,
    artifactStore,
    analyticsLogger,
    REFINEMENT_LIMITS,
  );
  registerCardSelectionRoutes(app, authStore, sessionStore);

  await app.ready();
  return { app, sessionStore, artifactStore, manifestStore, analyticsLogger };
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

/**
 * End-to-end refinement journey (Epic 5.12): rounds consumed correctly, the
 * gate triggers at the limit, and the free export path still works once
 * gated — driven through the real HTTP routes (not the orchestrator
 * directly), exercising the exact request/response contract a real client
 * depends on.
 *
 * A small refinementLimits ({app: 2, marketing: 2}) keeps the test fast
 * while still exercising the real boundary — the gate logic itself
 * (refinement-tracker.ts) doesn't care what the configured limit is.
 *
 * "Entitled users bypass" (the issue's third acceptance criterion) is
 * deliberately NOT covered here: there is no entitlement/tier system in
 * this codebase yet (Epic 6, still fully unbuilt — confirmed via direct
 * grep to have zero Stripe/tier code anywhere). That coverage belongs in
 * the Epic 6 follow-up once a real entitled-user concept exists to bypass
 * with; asserting it now would mean testing a system that doesn't exist.
 */
describe('app refinement journey - happy path, gate, and free export fallback (#96)', () => {
  it('consumes rounds correctly, meters accurately, gates at the limit, and still allows export once gated', async () => {
    const { app, sessionStore, artifactStore } = await buildTestApp();
    const authCookie = await signUpAndGetCookie(app);
    const sessionId = await createSessionAs(app, authCookie);

    // Seed an active build to refine against - matches what confirmBuild
    // + the real generation pipeline would have produced.
    await artifactStore.save(sessionId, 'app', { manifestId: 'm1', content: { code: 'old code' } });
    await sessionStore.update(sessionId, { activeAppVersion: 1 });

    // --- Round 1: happy path, meter goes from 0 to 1 ---
    const round1 = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine-app`,
      headers: { cookie: authCookie },
      payload: { changeRequest: 'Make the header blue' },
    });
    expect(round1.statusCode).toBe(200);
    expect(round1.json()).toMatchObject({ ok: true, kind: 'change_request', version: 2 });

    let session = await sessionStore.get(sessionId);
    expect(session!.appRefinementRounds).toBe(1);

    // --- Round 2: happy path, meter goes from 1 to 2 (the configured limit) ---
    const round2 = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine-app`,
      headers: { cookie: authCookie },
      payload: { changeRequest: 'Add a footer' },
    });
    expect(round2.statusCode).toBe(200);

    session = await sessionStore.get(sessionId);
    expect(session!.appRefinementRounds).toBe(2);

    // --- Round 3: gate path - the limit is reached, request rejected ---
    const round3 = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/refine-app`,
      headers: { cookie: authCookie },
      payload: { changeRequest: 'One more change' },
    });
    expect(round3.statusCode).toBe(429);
    expect(round3.json()).toMatchObject({ ok: false, error: 'refinement_limit_reached' });

    // The rejected round must NOT have consumed anything further - meter
    // accuracy holds exactly at the limit, not past it.
    session = await sessionStore.get(sessionId);
    expect(session!.appRefinementRounds).toBe(2);

    // --- Free export fallback: still works once gated (Epic 5.9's "no dead ends") ---
    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/export`,
      headers: { cookie: authCookie },
    });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.body).toContain(EDITED_CODE);

    const summaryRes = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/export/summary`,
      headers: { cookie: authCookie },
    });
    // No manifest was created in this test's setup, so the summary export
    // correctly reports nothing to summarize yet - the point being verified
    // here is that the route is reachable and responds sanely even while
    // the app-refinement gate is active, not this specific fixture's content.
    expect(summaryRes.statusCode).toBe(409);
  });
});

describe('marketing refinement journey - independent round tracking (#96)', () => {
  it('tracks marketing rounds independently of app rounds, and gates at its own limit', async () => {
    const { sessionStore, analyticsLogger } = await buildTestApp();
    const created = await sessionStore.create('user-1');
    const realSessionId = created.id;

    const renderTool = createRenderMarketingPlansTool({
      store: sessionStore,
      sessionId: realSessionId,
      onEvent: () => {},
    });
    await renderTool.render_marketing_plans(PLANS_INPUT);
    await renderTool.select_marketing_plan({ index: 0 });
    await sessionStore.update(realSessionId, { phase: 'refine' });

    const marketingTool = createMarketingRefinementTool({
      store: sessionStore,
      sessionId: realSessionId,
      renderMarketingPlans: renderTool.render_marketing_plans,
      limits: REFINEMENT_LIMITS,
    });

    // Round 1
    const revised1 = {
      plans: [{ ...PLAN, name: 'Revised once' }, PLANS_INPUT.plans[1], PLANS_INPUT.plans[2]],
    };
    const r1 = await marketingTool.refine_marketing_plans(revised1);
    expect(r1.ok).toBe(true);
    let session = await sessionStore.get(realSessionId);
    expect(session!.marketingRefinementRounds).toBe(1);
    // App rounds are untouched by marketing refinement - independently tracked.
    expect(session!.appRefinementRounds).toBe(0);

    // Round 2 (the configured limit)
    const revised2 = {
      plans: [{ ...PLAN, name: 'Revised twice' }, PLANS_INPUT.plans[1], PLANS_INPUT.plans[2]],
    };
    const r2 = await marketingTool.refine_marketing_plans(revised2);
    expect(r2.ok).toBe(true);
    session = await sessionStore.get(realSessionId);
    expect(session!.marketingRefinementRounds).toBe(2);

    // Round 3: gated
    const r3 = await marketingTool.refine_marketing_plans(revised2);
    expect(r3).toMatchObject({ ok: false, error: 'refinement_limit_reached' });
    session = await sessionStore.get(realSessionId);
    expect(session!.marketingRefinementRounds).toBe(2);

    // Analytics isn't wired for this direct-tool-call path (only the HTTP
    // routes emit gate_shown today) - this suite exercises the tool layer
    // directly for marketing since there's no dedicated HTTP route for it
    // yet (marketing refinement is chat-tool-driven, see #88).
    expect(analyticsLogger.info).not.toHaveBeenCalled();
  });
});
