import { type FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { type AuthStore } from '../auth/auth-store.js';
import {
  isSubscriptionCancellationFailure,
  type SubscriptionCancellationResult,
  type createSubscriptionCancellationTool,
} from '../subscription-cancellation.js';

const ERROR_STATUS: Record<
  Extract<SubscriptionCancellationResult, { ok: false }>['error'],
  number
> = {
  no_active_subscription: 404,
  cancellation_failed: 502,
};

/**
 * Self-serve subscription cancellation route (Epic 6.7, #103): the user's
 * own account is the only thing this can act on — `userId` always comes
 * from the authenticated session, never a request body, so a user can only
 * ever cancel their own subscription.
 */
export function registerSubscriptionCancellationRoutes(
  app: FastifyInstance,
  authStore: AuthStore,
  cancellationTool: ReturnType<typeof createSubscriptionCancellationTool>,
) {
  const auth = requireAuth(authStore);

  app.post('/api/subscription/cancel', { preHandler: auth }, async (request, reply) => {
    const result = await cancellationTool.cancelSubscription(request.userId!);

    if (isSubscriptionCancellationFailure(result)) {
      return reply.status(ERROR_STATUS[result.error]).send(result);
    }

    return reply.status(200).send(result);
  });
}
