import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from './auth.js';
import { type AuthStore } from '../auth/auth-store.js';
import {
  isCheckoutSessionFailure,
  type CheckoutSessionResult,
  type createCheckoutSessionTool,
} from '../stripe-checkout.js';
import { emitAnalyticsEvent, type AnalyticsLogger } from '../analytics.js';

const checkoutSchema = z.object({
  tierId: z.string().trim().min(1),
  /** Where the checkout was triggered from (Epic 6.11, #108's "offer->purchase conversion per surface") — e.g. 'refinement_gate', 'account_page'. Defaults to 'unknown' for callers that don't pass it. */
  surface: z.string().trim().min(1).default('unknown'),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const ERROR_STATUS: Record<Extract<CheckoutSessionResult, { ok: false }>['error'], number> = {
  unknown_tier: 400,
  disclaimer_not_accepted: 403,
  velocity_limit_exceeded: 429,
  checkout_session_failed: 502,
};

/**
 * Checkout route (Epic 6.2): creates a Stripe checkout session (one-off or
 * subscription, routed by tier — see stripe-checkout.ts) for the
 * authenticated user. Never trusts a client-supplied price; the tool this
 * delegates to always looks the amount up from the shared tier catalog
 * (#97).
 */
export function registerCheckoutRoutes(
  app: FastifyInstance,
  authStore: AuthStore,
  checkoutTool: ReturnType<typeof createCheckoutSessionTool>,
  analyticsLogger: AnalyticsLogger,
) {
  const auth = requireAuth(authStore);

  app.post('/api/checkout', { preHandler: auth }, async (request, reply) => {
    const parsed = checkoutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_failed' });
    }

    // customerEmail (#102) drives Stripe's automatic receipt-on-purchase
    // email — read from the authenticated user's own account rather than
    // trusting anything client-supplied for it.
    const user = await authStore.findUserById(request.userId!);

    const result = await checkoutTool.createCheckoutSession({
      tierId: parsed.data.tierId,
      userId: request.userId!,
      customerEmail: user?.email,
      successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl,
    });

    if (isCheckoutSessionFailure(result)) {
      return reply.status(ERROR_STATUS[result.error]).send(result);
    }

    emitAnalyticsEvent(analyticsLogger, {
      type: 'checkout_started',
      userId: request.userId!,
      tierId: parsed.data.tierId,
      surface: parsed.data.surface,
      cohort: result.cohort,
    });

    return reply.status(200).send(result);
  });
}
