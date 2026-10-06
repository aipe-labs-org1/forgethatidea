import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { PHASES, type Phase } from '@forge/shared';
import { requireAuth } from './auth.js';
import { type AuthStore } from '../auth/auth-store.js';
import { type SessionStore } from '../session-store.js';
import { transition, IllegalTransitionError, canTransition } from '../phase-machine.js';
import { checkGate, type SessionCard } from '../phase-gates.js';
import {
  recordRefinementRound,
  isRefinementFailure,
  type RefinementLimits,
} from '../refinement-tracker.js';
import { checkBrainstormStoppingRule } from '../brainstorm-logic.js';
import { checkSourcesIntakeComplete } from '../sources-logic.js';
import { emitAnalyticsEvent } from '../analytics.js';
import type { ManifestStore } from '../manifest-store.js';
import { freezeManifest, isFreezeManifestFailure } from '../manifest-freeze.js';

// `cards` is deliberately NOT client-writable here (#92): every real card
// mutation happens server-side, either via the render_* tool factories the
// agent's tool calls invoke, or via card-selection.ts's direct-click routes
// (which delegate to that same tool logic) — never via raw client-supplied
// content on this generic PATCH. Accepting an arbitrary `cards` array here
// let a client fabricate "locked" cards to pass the build gate without ever
// genuinely locking anything, since the phase-gate check below only has
// this request's own body and the session's stored state to consult.
const updateSchema = z.object({
  phase: z.enum(PHASES).optional(),
  chat: z.array(z.unknown()).optional(),
});

const brainstormFindingsSchema = z.object({
  icp: z.string().trim().min(1).optional(),
  coreJob: z.string().trim().min(1).optional(),
  differentiator: z.string().trim().min(1).optional(),
});

const refineSchema = z.object({
  kind: z.enum(['app', 'marketing']),
});

/**
 * True when a raw request body includes a `cards` field — never legitimate
 * on this route (#92: `cards` isn't in `updateSchema`; no real client ever
 * sends one). Checked against the raw body, before Zod's default
 * unknown-key stripping silently discards it, so an attempt to smuggle
 * fabricated card state past the phase gate is observable rather than
 * disappearing without a trace.
 */
export function isCardTamperAttempt(rawBody: unknown): boolean {
  return (
    rawBody !== null &&
    typeof rawBody === 'object' &&
    'cards' in (rawBody as Record<string, unknown>)
  );
}

/**
 * Session persistence & resume routes (Epic 1.10). All routes require an
 * authenticated user (via requireAuth, Epic 0.8) so a session is always tied
 * to a real account — satisfies "session tied to authenticated user".
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  authStore: AuthStore,
  store: SessionStore,
  refinementLimits: RefinementLimits,
  manifestStore: ManifestStore,
) {
  const auth = requireAuth(authStore);

  // Static per the current (no billing system yet, #92) free-tier config —
  // attached to every session response so the client can render a live
  // "N/limit" meter (#86) without a second round-trip just to learn the
  // ceiling. Also stamps `chatMessageCount` (a count, not the transcript
  // itself, which is already present separately as `chat`) so the client can
  // tell "has a real conversation started" apart from "has phase advanced
  // past onboarding" on resume — those aren't the same thing when the agent
  // is still asking clarifying questions in the first onboarding turns.
  function withRefinementLimits<T extends { chat: unknown[] }>(
    session: T,
  ): T & { refinementLimits: RefinementLimits; chatMessageCount: number } {
    return { ...session, refinementLimits, chatMessageCount: session.chat.length };
  }

  app.post(
    '/api/sessions',
    { preHandler: auth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const session = await store.create(request.userId!);
      return reply.status(201).send(withRefinementLimits(session));
    },
  );

  // Resume: latest session for the authenticated user, or null if they have
  // none yet. "Resume lands on correct phase" — the client reads `phase`
  // straight off this response and routes the UI accordingly.
  app.get(
    '/api/sessions/latest',
    { preHandler: auth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const [latest] = await store.listByUser(request.userId!);
      return reply.status(200).send(latest ? withRefinementLimits(latest) : null);
    },
  );

  // Project list (account/profile support): every session the user has
  // ever created, most-recently-updated first — `listByUser` already
  // returns exactly this shape, this route just stops discarding all but
  // the first entry the way /latest does. Lets the frontend offer a
  // project switcher instead of only ever resuming the single latest one.
  app.get(
    '/api/sessions',
    { preHandler: auth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const sessions = await store.listByUser(request.userId!);
      return reply.status(200).send(sessions.map(withRefinementLimits));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id',
    { preHandler: auth },
    async (request, reply) => {
      const session = await store.get(request.params.id);
      if (!session || session.userId !== request.userId) {
        return reply.status(404).send({ error: 'session_not_found' });
      }
      return reply.status(200).send(withRefinementLimits(session));
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/sessions/:id',
    { preHandler: auth },
    async (request, reply) => {
      if (isCardTamperAttempt(request.body)) {
        request.log.warn(
          { sessionId: request.params.id, userId: request.userId },
          'rejected client-supplied cards field on session PATCH — possible gate-tamper attempt',
        );
      }

      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_failed' });
      }

      const existing = await store.get(request.params.id);
      if (!existing || existing.userId !== request.userId) {
        return reply.status(404).send({ error: 'session_not_found' });
      }

      // Phase state machine (Epic 2.1): a phase change must be a legal
      // transition from the session's current phase — never an arbitrary
      // jump. A chat-only update doesn't touch the phase and skips this check.
      if (parsed.data.phase !== undefined) {
        try {
          transition(existing.phase, parsed.data.phase);
        } catch (err) {
          if (err instanceof IllegalTransitionError) {
            return reply.status(409).send({
              error: 'illegal_phase_transition',
              from: err.from,
              to: err.to,
            });
          }
          throw err;
        }

        // Phase gate enforcement (Epic 2.2): a structurally legal transition
        // can still be blocked by content rules — e.g. build requires all
        // four deliverable cards locked first. Always evaluated against the
        // session's own persisted cards (#92) — `cards` isn't a field this
        // request can supply at all (see updateSchema), so there's nothing
        // else it could mean anyway, but the intent is explicit: never trust
        // a client-supplied value for a gated check.
        const gate = checkGate(parsed.data.phase, existing.cards as SessionCard[]);
        if (!gate.passed) {
          return reply.status(409).send({
            error: 'phase_gate_not_satisfied',
            to: parsed.data.phase,
            missing: gate.missing,
          });
        }

        // Confirming the build here (the UI's Confirm build button) must
        // freeze the manifest exactly like the agent's transition_phase
        // tool does, or the build route refuses with manifest_not_frozen.
        if (parsed.data.phase === 'build') {
          const frozen = await freezeManifest({
            sessionStore: store,
            manifestStore,
            sessionId: request.params.id,
          });
          if (isFreezeManifestFailure(frozen)) {
            return reply.status(409).send({ error: frozen.error });
          }
        }
      }

      const updated = await store.update(request.params.id, parsed.data);
      return reply.status(200).send(withRefinementLimits(updated!));
    },
  );

  // Gate status (Epic 2.2): "gate status queryable by UI" — lets the client
  // show progress toward unlocking the next phase without attempting (and
  // getting rejected by) a real PATCH.
  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/gate',
    { preHandler: auth },
    async (request, reply) => {
      const session = await store.get(request.params.id);
      if (!session || session.userId !== request.userId) {
        return reply.status(404).send({ error: 'session_not_found' });
      }

      const currentIndex = PHASES.indexOf(session.phase);
      const next: Phase | null =
        currentIndex < PHASES.length - 1 ? PHASES[currentIndex + 1]! : null;
      if (!next || !canTransition(session.phase, next)) {
        return reply.status(200).send({ next: null, passed: true, missing: [] });
      }

      const gate = checkGate(next, session.cards as SessionCard[]);
      return reply.status(200).send({ next, ...gate });
    },
  );

  // Refinement round tracking (Epic 2.11): call once per change-request ->
  // re-emit cycle. Rejects with 429 once the free-tier limit for that kind
  // is already reached — the gate signal the UI (#23) reads to disable
  // further refinement.
  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/refine',
    { preHandler: auth },
    async (request, reply) => {
      const parsed = refineSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_failed' });
      }

      const existing = await store.get(request.params.id);
      if (!existing || existing.userId !== request.userId) {
        return reply.status(404).send({ error: 'session_not_found' });
      }

      const result = await recordRefinementRound(
        store,
        request.params.id,
        parsed.data.kind,
        refinementLimits,
      );

      if (isRefinementFailure(result)) {
        if (result.error === 'session_not_found') {
          return reply.status(404).send({ error: 'session_not_found' });
        }
        return reply.status(429).send(result);
      }

      emitAnalyticsEvent(request.log, {
        type: 'refinement_used',
        sessionId: request.params.id,
        kind: parsed.data.kind,
        round: result.rounds,
        limit: refinementLimits[parsed.data.kind],
      });

      return reply.status(200).send(result);
    },
  );

  // Brainstorm findings (Epic 2.7): merges the given fields into the
  // session's existing findings (never replaces — a caller reporting one
  // newly-learned finding shouldn't wipe the others) and returns the
  // stopping-rule status so the caller knows whether to keep asking
  // questions or move on — "writes findings to manifest" is satisfied by
  // persisting them on the session; promoting them into a real BuildManifest
  // is the planning phase's job once one is created.
  app.patch<{ Params: { id: string } }>(
    '/api/sessions/:id/brainstorm',
    { preHandler: auth },
    async (request, reply) => {
      const parsed = brainstormFindingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_failed' });
      }

      const existing = await store.get(request.params.id);
      if (!existing || existing.userId !== request.userId) {
        return reply.status(404).send({ error: 'session_not_found' });
      }

      const merged = { ...existing.brainstormFindings, ...parsed.data };
      const updated = await store.update(request.params.id, { brainstormFindings: merged });
      const stoppingRule = checkBrainstormStoppingRule(merged);

      return reply.status(200).send({ findings: updated!.brainstormFindings, ...stoppingRule });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/brainstorm',
    { preHandler: auth },
    async (request, reply) => {
      const session = await store.get(request.params.id);
      if (!session || session.userId !== request.userId) {
        return reply.status(404).send({ error: 'session_not_found' });
      }

      const stoppingRule = checkBrainstormStoppingRule(session.brainstormFindings);
      return reply.status(200).send({ findings: session.brainstormFindings, ...stoppingRule });
    },
  );

  // Sources intake status (Epic 2.8): read-only, so the UI can show intake
  // progress ("2 sources added" / "skipped") without polling via a mutating
  // call. Recording sources/declining is the orchestrator's job (via the
  // record_source/decline_sources tools) during the actual conversation.
  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/sources',
    { preHandler: auth },
    async (request, reply) => {
      const session = await store.get(request.params.id);
      if (!session || session.userId !== request.userId) {
        return reply.status(404).send({ error: 'session_not_found' });
      }

      const status = checkSourcesIntakeComplete(session.sourcesIntake);
      return reply.status(200).send({ ...session.sourcesIntake, ...status });
    },
  );
}
