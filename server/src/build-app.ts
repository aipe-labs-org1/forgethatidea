import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { loadEnv, type Env } from './env.js';
import { type OnboardingStore, createInMemoryOnboardingStore } from './onboarding-store.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { type AuthStore, createDbAuthStore, createInMemoryAuthStore } from './auth/auth-store.js';
import { registerAuthRoutes } from './routes/auth.js';
import {
  type SessionStore,
  createDbSessionStore,
  createInMemorySessionStore,
} from './session-store.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerCardSelectionRoutes } from './routes/card-selection.js';
import type { RefinementLimits } from './refinement-tracker.js';
import {
  createCostGuard,
  createInMemoryCostGuardStore,
  CostCapExceededError,
  type CostGuardStore,
} from './cost-guard.js';
import {
  createAnthropicClient,
  createSdkClient as createAnthropicSdkClient,
  type AnthropicClientDeps,
} from './anthropic-client.js';
import {
  createOpenAiClient,
  createSdkClient as createOpenAiSdkClient,
  type OpenAiClientDeps,
} from './openai-client.js';
import {
  createGeminiClient,
  createSdkClient as createGeminiSdkClient,
  type GeminiClientDeps,
} from './gemini-client.js';
import {
  createModelRouter,
  createUnconfiguredProviderClient,
  DEFAULT_TASK_REGISTRY,
  DEFAULT_PRICING,
  DEFAULT_FALLBACK_MODEL,
} from './model-router.js';
import { createDbClient, type Database } from './db/client.js';
import {
  createWebSearchTool,
  createTavilyWebSearchClient,
  createUnconfiguredWebSearchClient,
  type WebSearchClient,
} from './web-search.js';
import {
  createPricingCatalog,
  createCuratedPricingClient,
  type PricingClient,
} from './pricing-catalog.js';
import { createGetPricingTiersTool } from './get-pricing-tiers-tool.js';
import {
  createDbManifestStore,
  createInMemoryManifestStore,
  type ManifestStore,
} from './manifest-store.js';
import { createAgentOrchestrator, type OrchestratorAnthropicClient } from './agent-orchestrator.js';
import {
  createDbArtifactStore,
  createInMemoryArtifactStore,
  type ArtifactStore,
} from './artifact-store.js';
import { createBuildOrchestrator } from './build-orchestrator.js';
import { registerBuildRoutes } from './routes/build.js';
import { registerExportRoutes } from './routes/export.js';
import { registerAppArtifactRoutes } from './routes/app-artifact.js';
import { registerAppVersionsRoutes } from './routes/app-versions.js';
import { createRefineAppOrchestrator } from './refine-app-orchestrator.js';
import { createRefinementRateLimiter } from './refinement-rate-limiter.js';
import { registerRefineAppRoutes } from './routes/refine-app.js';
import { registerAgentRoutes } from './routes/agent.js';
import {
  createDbAnalyticsStore,
  createInMemoryAnalyticsStore,
  createPersistingAnalyticsLogger,
  type AnalyticsStore,
} from './analytics-store.js';
import { getTierCatalog } from './tier-catalog.js';
import {
  createCheckoutSessionTool,
  createUnconfiguredStripeClient,
  type StripeClient,
} from './stripe-checkout.js';
import { registerCheckoutRoutes } from './routes/checkout.js';
import { registerStripeWebhookRoutes } from './routes/stripe-webhook-route.js';
import type { StripeWebhookVerifier } from './stripe-webhook.js';
import {
  createStripeEventProcessor,
  createInMemoryProcessedEventStore,
  type StripeEventHandler,
} from './stripe-event-processor.js';
import {
  createEntitlementsService,
  createInMemoryEntitlementStore,
  type EntitlementStore,
} from './entitlements.js';
import { createEntitlementWebhookHandlers } from './entitlement-webhook-handlers.js';
import { registerEntitlementsRoutes } from './routes/entitlements.js';
import {
  createSubscriptionCancellationTool,
  createUnconfiguredSubscriptionCancelClient,
  type SubscriptionCancelClient,
} from './subscription-cancellation.js';
import { registerSubscriptionCancellationRoutes } from './routes/subscription-cancellation.js';
import { registerAccountRoutes } from './routes/account.js';
import {
  createDisclaimerAcceptanceService,
  createInMemoryDisclaimerAcceptanceStore,
  type DisclaimerAcceptanceStore,
} from './disclaimer-acceptance.js';
import { registerDisclaimerAcceptanceRoutes } from './routes/disclaimer-acceptance.js';
import { createPurchaseVelocityLimiter } from './purchase-velocity-limiter.js';
import type { PricingExperimentConfig } from './pricing-experiments.js';

declare module 'fastify' {
  interface FastifyInstance {
    anthropic?: ReturnType<typeof createAnthropicClient>;
    openai?: ReturnType<typeof createOpenAiClient>;
    gemini?: ReturnType<typeof createGeminiClient>;
    modelRouter: ReturnType<typeof createModelRouter>;
    db?: Database;
    costGuard: ReturnType<typeof createCostGuard>;
    webSearchTool: ReturnType<typeof createWebSearchTool>;
    pricingCatalog: ReturnType<typeof createPricingCatalog>;
    entitlements: ReturnType<typeof createEntitlementsService>;
  }
}

export interface BuildAppDeps {
  /** Onboarding persistence (Epic 1.4). Defaults to in-memory; swap for DB-backed with #7/#8. */
  onboardingStore?: OnboardingStore;
  /** Anthropic Messages API wrapper (Epic 0.9). Defaults to a real SDK client keyed by env. */
  anthropicClient?: ReturnType<typeof createAnthropicClient>;
  /** OpenAI API wrapper (Epic 0.9b). Defaults to a real SDK client keyed by env. */
  openAiClient?: ReturnType<typeof createOpenAiClient>;
  /** Gemini API wrapper (Epic 0.9c). Defaults to a real SDK client keyed by env. */
  geminiClient?: ReturnType<typeof createGeminiClient>;
  /** Multi-provider model router (Epic 0.9d). Defaults to real clients wired from env. */
  modelRouter?: ReturnType<typeof createModelRouter>;
  /** Postgres/Drizzle client (Epic 0.7). Defaults to a real pooled client keyed by DATABASE_URL. */
  db?: Database;
  /** Auth persistence (Epic 0.8). Defaults to DB-backed when `db` is available, else in-memory. */
  authStore?: AuthStore;
  /** Product/build session persistence (Epic 1.10). Defaults to DB-backed when `db` is available, else in-memory. */
  sessionStore?: SessionStore;
  /** Refinement round free-tier limits (Epic 2.11). Defaults to env-configured placeholder ceilings. */
  refinementLimits?: RefinementLimits;
  /** Cost guardrail spend tracking (Epic 0.11). Defaults to in-memory; swap for DB-backed once persisted spend history is needed. */
  costGuardStore?: CostGuardStore;
  /** Full cost guardrail (Epic 0.11). Defaults to one built from env caps + costGuardStore. */
  costGuard?: ReturnType<typeof createCostGuard>;
  /** Web search client (Epic 2.9). Defaults to a real Tavily client keyed by env, or an unconfigured stub. */
  webSearchClient?: WebSearchClient;
  /** Pricing data source (Epic 3.3). Defaults to the maintained curated snapshot (pricing-catalog.ts). */
  pricingClient?: PricingClient;
  /** Build manifest persistence (Epic 2.5/2.6). Defaults to DB-backed when `db` is available, else in-memory. */
  manifestStore?: ManifestStore;
  /** Anthropic client the agent orchestrator (Epic 2) calls directly — needs the richer tool-calling shape, not the generic model router. Defaults to `anthropicClient` above. */
  orchestratorAnthropicClient?: OrchestratorAnthropicClient;
  /** Generated-artifact persistence (Epic 4.13). Defaults to DB-backed when `db` is available, else in-memory. */
  artifactStore?: ArtifactStore;
  /** Durable analytics event log (Epic 5.11). Defaults to DB-backed when `db` is available, else in-memory. */
  analyticsStore?: AnalyticsStore;
  /** Stripe checkout client (Epic 6.2). Defaults to a real SDK-backed client keyed by env, or an unconfigured stub. */
  stripeClient?: StripeClient;
  /** Stripe webhook signature verifier (Epic 6.2). Defaults to a real SDK-backed verifier keyed by env; only registered when STRIPE_WEBHOOK_SECRET is set. */
  stripeWebhookVerifier?: StripeWebhookVerifier;
  /** Per-Stripe-event-type handlers the webhook processor dispatches to (Epic 6.3). Defaults to the real entitlement-granting handlers (entitlement-webhook-handlers.ts) wired against `entitlementStore` below. */
  stripeEventHandlers?: Record<string, StripeEventHandler>;
  /** Entitlement audit ledger (Epic 6.4). Defaults to in-memory; swap for DB-backed once durability across restarts is needed. */
  entitlementStore?: EntitlementStore;
  /** Subscription-cancel client (Epic 6.7). Defaults to a real SDK-backed client keyed by env, or an unconfigured stub. */
  subscriptionCancelClient?: SubscriptionCancelClient;
  /** Disclaimer-acceptance audit ledger (Epic 6.9). Defaults to in-memory; swap for DB-backed once durability across restarts is needed. */
  disclaimerAcceptanceStore?: DisclaimerAcceptanceStore;
  /** Purchase velocity limiter (Epic 6.10). Defaults to one built from env caps. */
  velocityLimiter?: ReturnType<typeof createPurchaseVelocityLimiter>;
  /** Active pricing experiment (Epic 6.13, #110). No default — undefined means every user is the implicit 'control' cohort at the base catalog price/copy. Not env-driven: an experiment's cohort list + per-tier overrides don't fit a flat env-var shape, and there's no live experiment running yet to configure. */
  pricingExperiment?: PricingExperimentConfig;
}

/**
 * Builds the Fastify instance. Kept separate from `index.ts` so tests can spin
 * up the app without binding a port (Epic 0.6 health check, future routes).
 */
export function buildApp(env: Env = loadEnv(), deps: BuildAppDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            }
          : undefined,
    },
    // Observability (Epic 0.10): correlate a request end-to-end. Reuse an
    // incoming x-request-id (from a client or upstream proxy) when present,
    // so a single trace ID can be followed across service boundaries.
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    },
  });

  app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  app.register(cookie);

  // Echo the correlated request ID back so callers/proxies can log against it.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Structured error capture with context (Epic 0.10). Logs every error with
  // its request ID, method, and URL; hides raw error messages in production
  // so internals never leak to a client, while dev/test see the real message.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    request.log.error(
      { err: error, reqId: request.id, method: request.method, url: request.url },
      'request failed',
    );

    // Cost guardrails (Epic 0.11): a clear, machine-readable 429 so callers
    // can distinguish "capped" from a generic server error.
    if (error instanceof CostCapExceededError) {
      return reply.status(429).send({
        error: error.reason,
        message: error.message,
        spendCents: error.spendCents,
        capCents: error.capCents,
      });
    }

    if (statusCode >= 500) {
      return reply.status(statusCode).send({
        error: 'internal_server_error',
        message: env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : error.message,
        reqId: request.id,
      });
    }

    return reply.status(statusCode).send({ error: error.name, message: error.message });
  });

  // Deploy skeleton health check (Epic 0.6). Reports liveness only — no secrets.
  app.get('/health', async () => ({
    status: 'ok',
    service: 'forge-server',
    env: env.NODE_ENV,
    uptime: process.uptime(),
  }));

  // Postgres/Drizzle client (Epic 0.7). Only constructed when DATABASE_URL is
  // present so the server still boots without one in dev/test.
  const db = deps.db ?? (env.DATABASE_URL ? createDbClient(env.DATABASE_URL) : undefined);
  if (db) app.decorate('db', db);

  // Durable analytics event log (Epic 5.11): DB-backed when a db client is
  // available, otherwise in-memory (dev/test) — same convention as the
  // other stores above. Wraps app.log so every existing analyticsLogger
  // call site persists automatically without any change to that call site.
  const analyticsStore =
    deps.analyticsStore ?? (db ? createDbAnalyticsStore(db) : createInMemoryAnalyticsStore());
  const analyticsLogger = createPersistingAnalyticsLogger(analyticsStore, app.log);

  // Onboarding schema + persistence (Epic 1.4).
  registerOnboardingRoutes(app, deps.onboardingStore ?? createInMemoryOnboardingStore());

  // Auth (Epic 0.8): email/password sign-up/sign-in, httpOnly session cookies.
  // DB-backed when a db client is available, otherwise in-memory (dev/test).
  const authStore = deps.authStore ?? (db ? createDbAuthStore(db) : createInMemoryAuthStore());
  registerAuthRoutes(app, authStore);

  // Session persistence & resume (Epic 1.10): phase/chat/cards tied to the
  // authenticated user. DB-backed when a db client is available, otherwise
  // in-memory (dev/test) — same convention as the auth store above.
  const sessionStore =
    deps.sessionStore ?? (db ? createDbSessionStore(db) : createInMemorySessionStore());
  const refinementLimits: RefinementLimits = deps.refinementLimits ?? {
    app: env.FREE_APP_REFINEMENT_LIMIT,
    marketing: env.FREE_MARKETING_REFINEMENT_LIMIT,
  };
  registerSessionRoutes(app, authStore, sessionStore, refinementLimits);
  registerCardSelectionRoutes(app, authStore, sessionStore);

  // Anthropic Messages API wrapper (Epic 0.9). Only constructed when a key is
  // present so the server still boots without one in dev/test.
  const anthropicClient =
    deps.anthropicClient ??
    (env.ANTHROPIC_API_KEY
      ? createAnthropicClient({
          sdkClient: createAnthropicSdkClient(env.ANTHROPIC_API_KEY),
          logger: app.log,
        } satisfies AnthropicClientDeps)
      : undefined);
  if (anthropicClient) app.decorate('anthropic', anthropicClient);

  // OpenAI API wrapper (Epic 0.9b). Only constructed when a key is present.
  const openAiClient =
    deps.openAiClient ??
    (env.OPENAI_API_KEY
      ? createOpenAiClient({
          sdkClient: createOpenAiSdkClient(env.OPENAI_API_KEY),
          logger: app.log,
        } satisfies OpenAiClientDeps)
      : undefined);
  if (openAiClient) app.decorate('openai', openAiClient);

  // Gemini API wrapper (Epic 0.9c). Only constructed when a key is present.
  const geminiClient =
    deps.geminiClient ??
    (env.GEMINI_API_KEY
      ? createGeminiClient({
          sdkClient: createGeminiSdkClient(env.GEMINI_API_KEY),
          logger: app.log,
        } satisfies GeminiClientDeps)
      : undefined);
  if (geminiClient) app.decorate('gemini', geminiClient);

  // Multi-provider model router (Epic 0.9d). The single entry point the agent
  // tool-call dispatch loop (#2.4) will use — never talks to individual
  // provider clients directly. Providers with no key configured fall back to
  // a stub client that throws clearly if a task's route ever needs them.
  const modelRouter =
    deps.modelRouter ??
    createModelRouter({
      clients: {
        anthropic: anthropicClient ?? createUnconfiguredProviderClient('anthropic'),
        openai: openAiClient ?? createUnconfiguredProviderClient('openai'),
        gemini: geminiClient ?? createUnconfiguredProviderClient('gemini'),
      },
      taskRegistry: DEFAULT_TASK_REGISTRY,
      pricing: DEFAULT_PRICING,
      fallbackModel: DEFAULT_FALLBACK_MODEL,
      logger: app.log,
    });
  app.decorate('modelRouter', modelRouter);

  // Cost guardrails (Epic 0.11): per-session and per-user daily spend caps
  // on top of the model router's normalized costCents, so runaway AI usage
  // is soft-warned then hard-stopped regardless of which provider served it.
  const costGuard =
    deps.costGuard ??
    createCostGuard({
      store: deps.costGuardStore ?? createInMemoryCostGuardStore(),
      sessionCapCents: env.SESSION_COST_CAP_CENTS,
      userDailyCapCents: env.USER_DAILY_COST_CAP_CENTS,
      warnRatio: env.COST_CAP_WARN_RATIO,
      logger: app.log,
    });
  app.decorate('costGuard', costGuard);

  // Web search / research tool (Epic 2.9): live search for competitor and
  // market research, cached + rate-limited. Falls back to an unconfigured
  // stub (clear error on use) when no TAVILY_API_KEY is set, same
  // boot-without-a-key convention as the AI provider clients above.
  const webSearchClient =
    deps.webSearchClient ??
    (env.TAVILY_API_KEY
      ? createTavilyWebSearchClient(env.TAVILY_API_KEY)
      : createUnconfiguredWebSearchClient());
  const webSearchTool = createWebSearchTool({ client: webSearchClient, logger: app.log });
  app.decorate('webSearchTool', webSearchTool);

  // Live pricing fetch service (Epic 3.3): defensible, sourced cost line
  // items for render_cost_table (#47). Defaults to the maintained curated
  // snapshot — see pricing-catalog.ts's doc comment for why this isn't a
  // live scrape.
  const pricingClient = deps.pricingClient ?? createCuratedPricingClient();
  const pricingCatalog = createPricingCatalog({ client: pricingClient });
  app.decorate('pricingCatalog', pricingCatalog);
  const getPricingTiersTool = createGetPricingTiersTool({ catalog: pricingCatalog });

  // Build manifest persistence (Epic 2.5/2.6). Same DB-backed-else-in-memory
  // convention as every other store above.
  const manifestStore =
    deps.manifestStore ?? (db ? createDbManifestStore(db) : createInMemoryManifestStore());

  // Agent orchestrator (Epic 2): the real conversational loop tying the
  // system prompt (#30), tool dispatcher (#31), manifest tools (#33), and
  // cost guardrails (#0.11) together. Talks to Anthropic directly (not
  // through modelRouter) because it needs the richer tool-calling content
  // blocks the router's generic streamMessage doesn't expose.
  const orchestratorAnthropicClient = deps.orchestratorAnthropicClient ?? anthropicClient;
  if (orchestratorAnthropicClient) {
    const orchestrator = createAgentOrchestrator({
      sessionStore,
      manifestStore,
      costGuard,
      anthropicClient: orchestratorAnthropicClient,
      extraTools: {
        web_search: webSearchTool.web_search,
        get_pricing_tiers: getPricingTiersTool.get_pricing_tiers,
      },
      analyticsLogger,
      logger: app.log,
      refinementLimits,
    });
    registerAgentRoutes(app, authStore, sessionStore, orchestrator);
  }

  // Generated-artifact persistence (Epic 4.13). Same DB-backed-else-in-memory
  // convention as every other store above.
  const artifactStore =
    deps.artifactStore ?? (db ? createDbArtifactStore(db) : createInMemoryArtifactStore());

  // Build orchestrator (Epic 4, wiring #61-67/#74 into a real route): only
  // registered once an Anthropic client is configured, same guard as the
  // agent orchestrator above — there's no meaningful build without a model
  // to generate from.
  if (orchestratorAnthropicClient) {
    const buildOrchestrator = createBuildOrchestrator({
      sessionStore,
      manifestStore,
      artifactStore,
      costGuard,
      anthropicClient: orchestratorAnthropicClient,
      analyticsLogger,
    });
    registerBuildRoutes(app, authStore, sessionStore, buildOrchestrator);

    // Refine-app orchestrator (Epic 4.15): targeted diff-edits to the active
    // build. Same Anthropic-client guard as the build route above. The rate
    // limiter (Epic 5.7) is process-lifetime in-memory state, constructed
    // once here rather than per-request.
    const refineAppOrchestrator = createRefineAppOrchestrator({
      sessionStore,
      artifactStore,
      anthropicClient: orchestratorAnthropicClient,
      refinementLimits,
      rateLimiter: createRefinementRateLimiter({ cooldownMs: env.REFINEMENT_RATE_LIMIT_MS }),
    });
    registerRefineAppRoutes(app, authStore, sessionStore, refineAppOrchestrator, analyticsLogger);
  }

  // App export (Epic 4.14): downloads the session's active build. Registered
  // unconditionally, unlike the build route — exporting an already-built
  // artifact needs no model call, so it doesn't depend on an Anthropic
  // client being configured.
  registerExportRoutes(
    app,
    authStore,
    sessionStore,
    manifestStore,
    artifactStore,
    analyticsLogger,
    refinementLimits,
  );

  // Active app artifact (Epic 5.10): lets a resumed session fetch its
  // existing build's code back as JSON, same no-model-call reasoning as
  // export above — registered unconditionally.
  registerAppArtifactRoutes(app, authStore, sessionStore, artifactStore);

  // Version list + revert (Epic 5.6): same no-model-call reasoning as
  // export/app-artifact above — registered unconditionally.
  registerAppVersionsRoutes(app, authStore, sessionStore, artifactStore);

  // Checkout (Epic 6.2): registered unconditionally — without a real
  // STRIPE_SECRET_KEY, deps.stripeClient defaults to the unconfigured stub
  // (stripe-checkout.ts), so the route exists and returns a clear
  // checkout_session_failed rather than 404ing, same convention as the
  // web-search tool falling back to an unconfigured client above. No real
  // SDK-backed StripeClient exists yet — building one needs a live
  // test-mode key to verify checkout.sessions.create calls actually work
  // end to end (see this PR's description).
  const stripeClient = deps.stripeClient ?? createUnconfiguredStripeClient();
  const tierCatalog = getTierCatalog(env);

  // Financial-pack disclaimer acceptance (Epic 6.9, #105): built before the
  // checkout tool since it gates financial-pack checkout directly.
  const disclaimerAcceptanceStore =
    deps.disclaimerAcceptanceStore ?? createInMemoryDisclaimerAcceptanceStore();
  const disclaimerAcceptance = createDisclaimerAcceptanceService({
    store: disclaimerAcceptanceStore,
  });
  registerDisclaimerAcceptanceRoutes(app, authStore, disclaimerAcceptance);

  // Purchase velocity limit (Epic 6.10, #107): a basic payment-abuse guard
  // — built unconditionally, no Stripe key needed since this only limits
  // checkout *attempts*, not real Stripe calls.
  const velocityLimiter =
    deps.velocityLimiter ??
    createPurchaseVelocityLimiter({
      maxAttempts: env.PURCHASE_VELOCITY_MAX_ATTEMPTS,
      windowMs: env.PURCHASE_VELOCITY_WINDOW_MS,
    });

  // Entitlements service (Epic 6.4): the single source of truth every gate
  // queries — "does this user own this tier." Built unconditionally (not
  // gated behind a real Stripe key) since admin overrides and future gate
  // checks need it regardless of whether real purchases are flowing yet.
  // Built before the checkout tool below since it needs entitlements for
  // the purchase-price-honor guardrail (#110).
  const entitlementStore = deps.entitlementStore ?? createInMemoryEntitlementStore();
  const entitlements = createEntitlementsService({ store: entitlementStore });
  app.decorate('entitlements', entitlements);

  const checkoutTool = createCheckoutSessionTool({
    client: stripeClient,
    catalog: tierCatalog,
    disclaimerAcceptance,
    velocityLimiter,
    entitlements,
    pricingExperiment: deps.pricingExperiment,
  });
  registerCheckoutRoutes(app, authStore, checkoutTool, analyticsLogger);

  // Entitlements read route (Epic 6.5): lets the frontend re-check what the
  // user owns after returning from checkout, without a full session
  // refetch or page reload.
  registerEntitlementsRoutes(app, authStore, entitlements);

  // Self-serve subscription cancellation (Epic 6.7, #103): registered
  // unconditionally like checkout — without a real STRIPE_SECRET_KEY,
  // deps.subscriptionCancelClient defaults to the unconfigured stub, so
  // the route exists and returns a clear cancellation_failed rather than
  // 404ing.
  const subscriptionCancelClient =
    deps.subscriptionCancelClient ?? createUnconfiguredSubscriptionCancelClient();
  const cancellationTool = createSubscriptionCancellationTool({
    client: subscriptionCancelClient,
    entitlements,
  });
  registerSubscriptionCancellationRoutes(app, authStore, cancellationTool);

  // Account data-export request (Epic 6.8, #104): logs the request
  // durably via the same analyticsLogger every other tracked event uses.
  registerAccountRoutes(app, authStore, analyticsLogger);

  // Stripe webhooks (Epic 6.2): only registered when a real verifier +
  // secret are available — unlike checkout, there's no meaningful
  // "unconfigured" webhook behavior to fall back to (a webhook endpoint
  // that always rejects isn't useful, and Stripe won't be sending events
  // for a service with no real STRIPE_WEBHOOK_SECRET anyway).
  if (deps.stripeWebhookVerifier && env.STRIPE_WEBHOOK_SECRET) {
    // Idempotent dispatch (Epic 6.3, #99) into the real entitlement-
    // granting handlers (Epic 6.4, #100) — checkout.session.completed
    // grants, charge.refunded/customer.subscription.deleted revoke.
    const stripeEventProcessor = createStripeEventProcessor({
      store: createInMemoryProcessedEventStore(),
      handlers:
        deps.stripeEventHandlers ??
        createEntitlementWebhookHandlers({
          entitlements,
          catalog: tierCatalog,
          analyticsLogger,
          // Duplicate-account entitlement sharing (Epic 6.10, #107): flag
          // via a structured warn log rather than blocking the purchase —
          // a real fraud pipeline reads this, no automatic action is taken.
          alertOnAnomaly: (anomaly) =>
            app.log.warn(
              {
                userId: anomaly.userId,
                tierId: anomaly.tierId,
                buyerEmail: anomaly.buyerEmail,
                sharedWithUserIds: anomaly.sharedWithUserIds,
              },
              'entitlement sharing anomaly: same buyer email granted the same tier across multiple accounts',
            ),
        }),
      alertOnFailure: (alert) =>
        app.log.error(
          { eventId: alert.eventId, eventType: alert.eventType, details: alert.details },
          'stripe webhook event failed to process',
        ),
    });
    registerStripeWebhookRoutes(
      app,
      deps.stripeWebhookVerifier,
      env.STRIPE_WEBHOOK_SECRET,
      stripeEventProcessor,
    );
  }

  return app;
}
