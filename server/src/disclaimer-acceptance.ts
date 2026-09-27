export interface DisclaimerAcceptanceRecord {
  userId: string;
  disclaimerId: string;
  version: string;
  acceptedAt: Date;
}

/**
 * Append-only audit ledger of every disclaimer acceptance (Epic 6.9, #105)
 * — never overwrites a prior acceptance, so "who accepted what version,
 * when" is always reconstructable, same pattern as EntitlementStore's
 * grant/revoke ledger.
 */
export interface DisclaimerAcceptanceStore {
  record(userId: string, disclaimerId: string, version: string): Promise<void>;
  listByUser(userId: string): Promise<DisclaimerAcceptanceRecord[]>;
}

export function createInMemoryDisclaimerAcceptanceStore(): DisclaimerAcceptanceStore {
  const records: DisclaimerAcceptanceRecord[] = [];

  return {
    async record(userId, disclaimerId, version) {
      records.push({ userId, disclaimerId, version, acceptedAt: new Date() });
    },
    async listByUser(userId) {
      return records.filter((r) => r.userId === userId);
    },
  };
}

export interface DisclaimerAcceptanceServiceDeps {
  store: DisclaimerAcceptanceStore;
}

/**
 * Disclaimer/assumptions acceptance gate (Epic 6.9): the generic mechanism
 * behind "purchase possible only after acceptance" — keyed by an arbitrary
 * `disclaimerId` string rather than hardcoded to the financial pack alone,
 * so the same service could later gate ToS acceptance (#106) without a
 * second implementation. `hasAccepted` requires an exact version match:
 * accepting version "2026-01.1" does NOT satisfy a check against
 * "2026-02.1" — satisfies "re-acceptance required when disclaimer version
 * changes" by construction, with no separate invalidation step needed.
 */
export function createDisclaimerAcceptanceService(deps: DisclaimerAcceptanceServiceDeps) {
  const { store } = deps;

  async function hasAccepted(
    userId: string,
    disclaimerId: string,
    version: string,
  ): Promise<boolean> {
    const records = await store.listByUser(userId);
    return records.some((r) => r.disclaimerId === disclaimerId && r.version === version);
  }

  async function recordAcceptance(
    userId: string,
    disclaimerId: string,
    version: string,
  ): Promise<void> {
    await store.record(userId, disclaimerId, version);
  }

  return { hasAccepted, recordAcceptance };
}
