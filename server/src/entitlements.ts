import { isTierId, type TierId } from './tier-catalog.js';

export type EntitlementSource = 'purchase' | 'refund' | 'admin_override' | 'subscription_cancel';

export interface EntitlementChangeContext {
  source: EntitlementSource;
  /** Free-form provenance for the audit trail — a Stripe checkout session id, a refund id, or a support ticket reference for an admin override. */
  reference: string;
  /** The buyer's billing email at the time of purchase (Epic 6.10, #107) — captured so duplicate-account entitlement sharing (the same email buying the same tier under multiple accounts) can be flagged. Optional since not every grant is purchase-driven (e.g. an admin override). */
  buyerEmail?: string;
  /** The real price paid at the time of purchase (Epic 6.13, #110) — captured so a later resubscribe can be honoured at this historical price rather than whatever a pricing experiment currently shows. Optional since not every grant is purchase-driven. */
  purchasePriceCents?: number;
}

export interface EntitlementRecord {
  userId: string;
  tierId: TierId;
  action: 'grant' | 'revoke';
  source: EntitlementSource;
  reference: string;
  buyerEmail?: string;
  purchasePriceCents?: number;
  createdAt: Date;
}

/**
 * Append-only audit ledger of every entitlement grant/revoke (Epic 6.4) —
 * never overwrites a prior record, so "who granted/revoked what, when, and
 * why (including admin overrides)" is always reconstructable. Same
 * interface + swappable-implementation pattern as SessionStore/ArtifactStore.
 */
export interface EntitlementStore {
  grant(userId: string, tierId: TierId, context: EntitlementChangeContext): Promise<void>;
  revoke(userId: string, tierId: TierId, context: EntitlementChangeContext): Promise<void>;
  /** Every tier this user currently owns — a revoke after a grant nets that tier back out. */
  listOwnedTiers(userId: string): Promise<TierId[]>;
  /** Full chronological audit trail for this user — every grant and revoke, never collapsed. */
  listByUser(userId: string): Promise<EntitlementRecord[]>;
  /**
   * The most recent grant's reference for this user+tier, or null if never
   * granted (Epic 6.7, #103) — for a subscription tier this is the Stripe
   * subscription id, which is what a self-serve cancel needs to call
   * `stripe.subscriptions.cancel` on the right subscription.
   */
  findLatestGrantReference(userId: string, tierId: TierId): Promise<string | null>;
  /**
   * Every distinct userId (other than the one passed in) that has ever
   * been granted this tier under the same buyer email (Epic 6.10, #107's
   * "entitlement sharing anomalies flagged") — a real, if basic, signal
   * that the same buyer (or someone sharing their billing details) is
   * getting the same paid product across multiple accounts.
   */
  findOtherUsersGrantedWithEmail(
    userId: string,
    tierId: TierId,
    buyerEmail: string,
  ): Promise<string[]>;
  /**
   * The most recent grant's purchase price for this user+tier, or null if
   * never granted (Epic 6.13, #110) — the "purchasers always honoured at
   * purchase price" guardrail: a resubscribe checkout should charge this
   * price, not whatever the current pricing experiment shows.
   */
  findLatestPurchasePriceCents(userId: string, tierId: TierId): Promise<number | null>;
}

export function createInMemoryEntitlementStore(): EntitlementStore {
  const records: EntitlementRecord[] = [];

  return {
    async grant(userId, tierId, context) {
      records.push({ userId, tierId, action: 'grant', ...context, createdAt: new Date() });
    },
    async revoke(userId, tierId, context) {
      records.push({ userId, tierId, action: 'revoke', ...context, createdAt: new Date() });
    },
    async listOwnedTiers(userId) {
      const owned = new Set<TierId>();
      for (const record of records) {
        if (record.userId !== userId) continue;
        if (record.action === 'grant') owned.add(record.tierId);
        else owned.delete(record.tierId);
      }
      return [...owned];
    },
    async listByUser(userId) {
      return records.filter((r) => r.userId === userId);
    },
    async findLatestGrantReference(userId, tierId) {
      const grants = records.filter(
        (r) => r.userId === userId && r.tierId === tierId && r.action === 'grant',
      );
      const latest = grants[grants.length - 1];
      return latest?.reference ?? null;
    },
    async findOtherUsersGrantedWithEmail(userId, tierId, buyerEmail) {
      const others = new Set<string>();
      for (const record of records) {
        if (
          record.action === 'grant' &&
          record.tierId === tierId &&
          record.buyerEmail === buyerEmail &&
          record.userId !== userId
        ) {
          others.add(record.userId);
        }
      }
      return [...others];
    },
    async findLatestPurchasePriceCents(userId, tierId) {
      const grants = records.filter(
        (r) => r.userId === userId && r.tierId === tierId && r.action === 'grant',
      );
      const latest = grants[grants.length - 1];
      return latest?.purchasePriceCents ?? null;
    },
  };
}

export interface EntitlementsServiceDeps {
  store: EntitlementStore;
}

/**
 * Entitlements service (Epic 6.4): the single source of truth every gate
 * (#92, and every future paid-module gate) queries — "does this user own
 * this tier" — backed by an in-memory read cache so a hot path like a
 * per-request gate check doesn't hit the store on every call (the issue's
 * "<50ms cached" criterion). The cache is a plain per-user Set, invalidated
 * immediately on grant/revoke rather than on a TTL — correctness after a
 * purchase matters more than cache hit rate here, and the write path
 * (checkout/refund webhooks) is far rarer than the read path (every gated
 * action).
 */
export function createEntitlementsService(deps: EntitlementsServiceDeps) {
  const { store } = deps;
  const cache = new Map<string, Set<TierId>>();

  async function loadIntoCache(userId: string): Promise<Set<TierId>> {
    const owned = new Set(await store.listOwnedTiers(userId));
    cache.set(userId, owned);
    return owned;
  }

  async function ownedTiers(userId: string): Promise<Set<TierId>> {
    return cache.get(userId) ?? (await loadIntoCache(userId));
  }

  async function hasEntitlement(userId: string, tierId: string): Promise<boolean> {
    if (!isTierId(tierId)) return false;
    const owned = await ownedTiers(userId);
    return owned.has(tierId);
  }

  async function listEntitlements(userId: string): Promise<TierId[]> {
    return [...(await ownedTiers(userId))];
  }

  async function grant(
    userId: string,
    tierId: TierId,
    context: EntitlementChangeContext,
  ): Promise<void> {
    await store.grant(userId, tierId, context);
    cache.delete(userId);
  }

  async function revoke(
    userId: string,
    tierId: TierId,
    context: EntitlementChangeContext,
  ): Promise<void> {
    await store.revoke(userId, tierId, context);
    cache.delete(userId);
  }

  async function findGrantReference(userId: string, tierId: TierId): Promise<string | null> {
    return store.findLatestGrantReference(userId, tierId);
  }

  async function findSharedAccounts(
    userId: string,
    tierId: TierId,
    buyerEmail: string,
  ): Promise<string[]> {
    return store.findOtherUsersGrantedWithEmail(userId, tierId, buyerEmail);
  }

  async function findHistoricalPriceCents(userId: string, tierId: TierId): Promise<number | null> {
    return store.findLatestPurchasePriceCents(userId, tierId);
  }

  return {
    hasEntitlement,
    listEntitlements,
    grant,
    revoke,
    findGrantReference,
    findSharedAccounts,
    findHistoricalPriceCents,
  };
}
