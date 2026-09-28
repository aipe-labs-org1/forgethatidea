import { z } from 'zod';

/**
 * Environment contract (Epic 0.3). The server validates every required variable
 * at boot and fails fast with a readable message instead of crashing later deep
 * in a request. No secret values live in the repo — see `.env.example`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Anthropic (Epic 0.9). Optional in dev/test so the server boots without it,
  // required in production.
  ANTHROPIC_API_KEY: z.string().optional(),

  // OpenAI (Epic 0.9b). Optional everywhere for now — the model router (0.9d)
  // will hard-require it in production only when a task routes to OpenAI.
  OPENAI_API_KEY: z.string().optional(),

  // Gemini (Epic 0.9c). Optional everywhere for now — the model router (0.9d)
  // will hard-require it in production only when a task routes to Gemini.
  GEMINI_API_KEY: z.string().optional(),

  // Postgres (Epic 0.7). Same treatment.
  DATABASE_URL: z.string().url().optional(),

  // CORS origin for the Vite app in dev/prod.
  WEB_ORIGIN: z.string().default('http://localhost:5173'),

  // Tavily web search (Epic 2.9) — competitor/market research tool. Optional
  // everywhere: without a key the tool falls back to an "unconfigured"
  // client that errors clearly rather than the server failing to boot.
  TAVILY_API_KEY: z.string().optional(),

  // Cost guardrails (Epic 0.11). Ceilings in cents to prevent runaway AI
  // spend; soft-warn logs as usage crosses the threshold, hard-stop rejects
  // once the cap is reached. Defaults are conservative placeholders — tune
  // per real usage once the product is live.
  SESSION_COST_CAP_CENTS: z.coerce.number().positive().default(200), // $2.00/session
  USER_DAILY_COST_CAP_CENTS: z.coerce.number().positive().default(1000), // $10.00/user/day
  COST_CAP_WARN_RATIO: z.coerce.number().min(0).max(1).default(0.8), // warn at 80% of cap

  // Refinement round free-tier limits (Epic 2.11). No real entitlement/
  // billing system exists yet (that's Epic 9/11's job) — these are
  // placeholder ceilings applied to every session until a real tier system
  // replaces them. App and marketing tracked independently since a real
  // pricing model will very likely price them differently.
  FREE_APP_REFINEMENT_LIMIT: z.coerce.number().int().nonnegative().default(3),
  FREE_MARKETING_REFINEMENT_LIMIT: z.coerce.number().int().nonnegative().default(3),

  // Refinement abuse guard (Epic 5.7): minimum interval between two
  // refine-app calls on the same session — catches rapid-fire/scripted
  // spam without affecting normal human pace between refinements.
  REFINEMENT_RATE_LIMIT_MS: z.coerce.number().int().nonnegative().default(3000),

  // Tier price points (Epic 6.1). Env-configurable so prices can be tuned
  // (or set to a small test value) without a code change — tier-catalog.ts
  // is the single source of truth these feed into. Defaults are launch
  // placeholders, not researched pricing.
  PRICE_APP_REFINEMENT_TOPUP_CENTS: z.coerce.number().int().positive().default(500), // $5.00
  PRICE_SPEC_PACK_CENTS: z.coerce.number().int().positive().default(1900), // $19.00
  PRICE_PITCH_DECK_CENTS: z.coerce.number().int().positive().default(2900), // $29.00
  PRICE_FINANCIAL_PACK_CENTS: z.coerce.number().int().positive().default(4900), // $49.00

  // Stripe (Epic 6.2). Optional everywhere for now, same boot-without-a-key
  // convention as TAVILY_API_KEY above — without a key the checkout tool
  // falls back to an "unconfigured" client that errors clearly on use
  // rather than the server failing to boot.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Purchase velocity limit (Epic 6.10, #107): a basic payment-abuse guard
  // — at most N checkout-session attempts per user within the window,
  // catching a scripted card-testing pattern without affecting a normal
  // human buying a couple of tiers in one sitting.
  PURCHASE_VELOCITY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PURCHASE_VELOCITY_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000), // 10 minutes
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  // Production hard requirements: secrets must be present.
  if (env.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (!env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
    if (!env.DATABASE_URL) missing.push('DATABASE_URL');
    if (missing.length > 0) {
      throw new Error(`Missing required production env vars: ${missing.join(', ')}`);
    }
  }

  cached = env;
  return env;
}
