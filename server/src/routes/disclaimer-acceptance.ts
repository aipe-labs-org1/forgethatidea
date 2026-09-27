import { type FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { type AuthStore } from '../auth/auth-store.js';
import type { createDisclaimerAcceptanceService } from '../disclaimer-acceptance.js';
import {
  FINANCIAL_PACK_DISCLAIMER_ID,
  FINANCIAL_PACK_DISCLAIMER_VERSION,
} from '../financial-pack-disclaimer.js';

/**
 * Financial-pack disclaimer acceptance route (Epic 6.9, #105): records the
 * signed-in user's acceptance of the current disclaimer version so a
 * subsequent financial-pack checkout (stripe-checkout.ts's gate) passes.
 * Always accepts at the *current* version — there is no way to accept an
 * older or arbitrary version, so a client can't pre-record acceptance of a
 * version that later changes.
 */
export function registerDisclaimerAcceptanceRoutes(
  app: FastifyInstance,
  authStore: AuthStore,
  disclaimerAcceptance: ReturnType<typeof createDisclaimerAcceptanceService>,
) {
  const auth = requireAuth(authStore);

  app.post(
    '/api/disclaimers/financial-pack/accept',
    { preHandler: auth },
    async (request, reply) => {
      await disclaimerAcceptance.recordAcceptance(
        request.userId!,
        FINANCIAL_PACK_DISCLAIMER_ID,
        FINANCIAL_PACK_DISCLAIMER_VERSION,
      );
      return reply.status(200).send({ ok: true, version: FINANCIAL_PACK_DISCLAIMER_VERSION });
    },
  );
}
