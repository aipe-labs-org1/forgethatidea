import { pgTable, uuid, text, timestamp, jsonb, integer, pgEnum } from 'drizzle-orm/pg-core';

/**
 * Baseline schema (Epic 0.7): users, sessions, manifests, artifacts.
 * This is the database for Forge itself — not for the mocked apps it
 * generates (see architecture.md § 4.1).
 */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  /** argon2id hash (Epic 0.8) — never the plaintext password. */
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Login sessions (Epic 0.8) — deliberately separate from the `sessions`
 * table below, which is the product/build session (phase state machine).
 * A login persists across many product sessions and has its own lifecycle
 * (sign in/out, expiry), so conflating the two would tie a user's login to
 * a single build session's lifetime.
 */
export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** SHA-256 hash of the session token — the raw token lives only in the client's cookie. */
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const phaseEnum = pgEnum('phase', [
  'onboarding',
  'sources',
  'brainstorm',
  'planning',
  'build',
  'refine',
]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  phase: phaseEnum('phase').notNull().default('onboarding'),
  /**
   * Chat transcript and canvas card state (Epic 1.10), so a refresh or a
   * resume restores exactly what the user left. Stored as flexible JSONB for
   * now — kept intentionally generic (array of arbitrary message/card
   * objects) since the real message and card schemas are formalized by the
   * phase state machine (#28) and manifest schema (#32). Once those land,
   * this can be tightened to a typed shape without changing the column.
   */
  chat: jsonb('chat').notNull().default([]),
  cards: jsonb('cards').notNull().default([]),
  /**
   * Brainstorm phase findings (Epic 2.7) — icp/coreJob/differentiator,
   * captured incrementally before enough is known to seed the real build
   * manifest (#32). See brainstorm-logic.ts for why these live here rather
   * than on the manifest itself.
   */
  brainstormFindings: jsonb('brainstorm_findings').notNull().default({}),
  /**
   * Sources/RAG intake (Epic 2.8) — competitor names/apps/reference links
   * the user provides for research, or an explicit decline ("none"). See
   * sources-logic.ts for why these live here rather than on the manifest.
   */
  sourcesIntake: jsonb('sources_intake').notNull().default({ sources: [], declined: false }),
  /**
   * Refinement round counters (Epic 2.11) — app and marketing tracked
   * independently, since the free-tier limits differ per Epic 9/11's future
   * pricing model. A "round" is one change-request -> re-emit cycle.
   */
  appRefinementRounds: integer('app_refinement_rounds').notNull().default(0),
  marketingRefinementRounds: integer('marketing_refinement_rounds').notNull().default(0),
  /**
   * The manifest version the build pipeline reads (Epic 3.8) — null until a
   * build has ever been requested. Set only by `freezeManifest`, never a raw
   * session update, so post-freeze manifest edits never retroactively change
   * what an in-flight or completed build was generated from.
   */
  frozenManifestVersion: integer('frozen_manifest_version'),
  /**
   * Which `app`-type artifact version (artifacts.version, scoped to this
   * session) is the one currently shown/exported (Epic 4.13) — set on every
   * successful build and movable independently by a revert, so "revert to a
   * previous build" only repoints this rather than deleting or reordering
   * any artifact row. Null until a build has ever succeeded.
   */
  activeAppVersion: integer('active_app_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const manifests = pgTable('manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  /** Monotonically increasing per session — every write is a new, immutable version. */
  version: integer('version').notNull().default(1),
  /** The manifest payload (entities, screens, roles, branding, etc.) — schema TBD by #32. */
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const artifactTypeEnum = pgEnum('artifact_type', [
  'app',
  'spec-pack',
  'pitch-deck',
  'financial-pack',
]);

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  manifestId: uuid('manifest_id').references(() => manifests.id, { onDelete: 'set null' }),
  type: artifactTypeEnum('type').notNull(),
  /** Monotonically increasing per (sessionId, type) — every build is a new, immutable version, never an update-in-place (Epic 4.13). */
  version: integer('version').notNull().default(1),
  /**
   * The artifact payload itself (e.g. generated app source code for `app`
   * type) — stored directly for now rather than in real object storage,
   * since no object-storage integration exists yet in this codebase.
   * `storageKey` stays as the seam a future migration to real blob storage
   * plugs into without changing this table's shape.
   */
  content: jsonb('content'),
  /** Where the artifact content lives in object storage, once that exists — nullable until then. */
  storageKey: text('storage_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Analytics event log (Epic 5.11): a durable, queryable record of every
 * event emitted via analytics.ts's `emitAnalyticsEvent`, alongside (not
 * instead of) the existing Pino log line — the log line stays for
 * operational visibility/tailing, this table is what makes funnel metrics
 * (rounds-used distribution, gate hit rate, gate→export rate) queryable
 * rather than requiring log aggregation infra that doesn't exist here.
 * `sessionId` is deliberately nullable+unconstrained (no FK) since a
 * session can be deleted while its historical analytics should still be
 * queryable — funnel analysis outliving the session it came from is the
 * whole point.
 */
export const analyticsEvents = pgTable('analytics_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  /** Nullable (Epic 6.11, #108): not every analytics event is tied to a build session — a purchase or a data-export request is scoped to a user, not a session. */
  sessionId: text('session_id'),
  /** The event's own fields (kind, rounds, limit, version, etc.) — shape varies per type, same union as analytics.ts's AnalyticsEvent. */
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
