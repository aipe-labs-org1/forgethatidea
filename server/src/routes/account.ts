import { type FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { type AuthStore } from '../auth/auth-store.js';
import { emitAnalyticsEvent, type AnalyticsLogger } from '../analytics.js';

/**
 * Data export request route (Epic 6.8, #104's "session/data export request
 * path"): durably logs that a user has asked for a full export of their
 * account data (userId, from an authenticated request only), so the
 * request is recorded and actionable. Fulfilling it — actually assembling
 * and delivering the data — is a separate, larger effort (real GDPR-style
 * subject-access-request handling); this route is deliberately scoped to
 * "a path exists to make the request," per this issue's own acceptance
 * criterion wording.
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  authStore: AuthStore,
  analyticsLogger: AnalyticsLogger,
) {
  const auth = requireAuth(authStore);

  app.post('/api/account/export-request', { preHandler: auth }, async (request, reply) => {
    emitAnalyticsEvent(analyticsLogger, {
      type: 'data_export_requested',
      userId: request.userId!,
    });
    return reply.status(200).send({ ok: true });
  });
}
