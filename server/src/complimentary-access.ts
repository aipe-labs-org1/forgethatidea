import { TIER_IDS, isTierId, type TierId } from './tier-catalog.js';
import type { createEntitlementsService } from './entitlements.js';

type EntitlementsService = ReturnType<typeof createEntitlementsService>;

export function parseComplimentaryEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

export interface ComplimentaryAccessDeps {
  emails: Set<string>;
  findUserById: (id: string) => Promise<{ email: string } | null>;
}

/**
 * Gives allowlisted accounts (demo, internal QA) every paid tier without a
 * purchase — configured server-side via COMPLIMENTARY_ACCESS_EMAILS, never
 * from a request. Read-time only: nothing is written to the entitlement
 * ledger, so removing an email from the list revokes access immediately and
 * revenue analytics never see a fake purchase. Everyone else falls through
 * to their real purchases unchanged.
 */
export function withComplimentaryAccess(
  entitlements: EntitlementsService,
  deps: ComplimentaryAccessDeps,
): EntitlementsService {
  const { emails, findUserById } = deps;

  async function isComplimentary(userId: string): Promise<boolean> {
    if (emails.size === 0) return false;
    const user = await findUserById(userId);
    return user !== null && emails.has(user.email.trim().toLowerCase());
  }

  return {
    ...entitlements,
    async hasEntitlement(userId, tierId) {
      if (!isTierId(tierId)) return false;
      if (await isComplimentary(userId)) return true;
      return entitlements.hasEntitlement(userId, tierId);
    },
    async listEntitlements(userId): Promise<TierId[]> {
      if (await isComplimentary(userId)) return [...TIER_IDS];
      return entitlements.listEntitlements(userId);
    },
  };
}
