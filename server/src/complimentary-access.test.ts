import { describe, it, expect, vi } from 'vitest';
import { parseComplimentaryEmails, withComplimentaryAccess } from './complimentary-access.js';
import { createEntitlementsService, createInMemoryEntitlementStore } from './entitlements.js';
import { TIER_IDS } from './tier-catalog.js';

const users: Record<string, string> = { 'u-demo': 'Demo@Forge.test', 'u-paying': 'paying@x.com' };
const findUserById = vi.fn(async (id: string) => (users[id] ? { id, email: users[id]! } : null));

function service(emails = 'demo@forge.test') {
  const base = createEntitlementsService({ store: createInMemoryEntitlementStore() });
  return {
    base,
    wrapped: withComplimentaryAccess(base, {
      emails: parseComplimentaryEmails(emails),
      findUserById,
    }),
  };
}

describe('parseComplimentaryEmails', () => {
  it('splits, trims and lower-cases a comma list, ignoring blanks', () => {
    expect([...parseComplimentaryEmails(' A@x.com, ,b@Y.com ')]).toEqual(['a@x.com', 'b@y.com']);
  });

  it('returns an empty set when unset', () => {
    expect(parseComplimentaryEmails(undefined).size).toBe(0);
  });
});

describe('withComplimentaryAccess', () => {
  it('grants every paid tier to an allowlisted account (case-insensitive email)', async () => {
    const { wrapped } = service();
    for (const tier of TIER_IDS) {
      expect(await wrapped.hasEntitlement('u-demo', tier)).toBe(true);
    }
    expect((await wrapped.listEntitlements('u-demo')).sort()).toEqual([...TIER_IDS].sort());
  });

  it('leaves everyone else on their real purchases only', async () => {
    const { base, wrapped } = service();
    expect(await wrapped.hasEntitlement('u-paying', 'pitch-deck')).toBe(false);
    await base.grant('u-paying', 'pitch-deck', { source: 'purchase', reference: 'cs_1' });
    expect(await wrapped.hasEntitlement('u-paying', 'pitch-deck')).toBe(true);
    expect(await wrapped.listEntitlements('u-paying')).toEqual(['pitch-deck']);
  });

  it('never grants anything for an unknown tier id', async () => {
    const { wrapped } = service();
    expect(await wrapped.hasEntitlement('u-demo', 'not-a-tier')).toBe(false);
  });

  it('grants nothing extra when the allowlist is empty', async () => {
    const { wrapped } = service('');
    expect(await wrapped.hasEntitlement('u-demo', 'spec-pack')).toBe(false);
  });

  it('passes grant/revoke and the other service methods straight through', async () => {
    const { wrapped } = service();
    await wrapped.grant('u-paying', 'spec-pack', { source: 'purchase', reference: 'cs_2' });
    expect(await wrapped.findGrantReference('u-paying', 'spec-pack')).toBe('cs_2');
  });
});
