import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEntitlementsService, createInMemoryEntitlementStore } from './entitlements.js';

describe('entitlements service (#100)', () => {
  it('reports no entitlements for a user who has never purchased anything', async () => {
    const store = createInMemoryEntitlementStore();
    const service = createEntitlementsService({ store });

    const owns = await service.hasEntitlement('user-1', 'spec-pack');

    expect(owns).toBe(false);
  });

  it('grants an entitlement and reports it owned afterward', async () => {
    const store = createInMemoryEntitlementStore();
    const service = createEntitlementsService({ store });

    await service.grant('user-1', 'spec-pack', { source: 'purchase', reference: 'cs_test_1' });

    expect(await service.hasEntitlement('user-1', 'spec-pack')).toBe(true);
    // Scoped per user — someone else's account is unaffected.
    expect(await service.hasEntitlement('user-2', 'spec-pack')).toBe(false);
    // Scoped per tier — granting one tier doesn't grant another.
    expect(await service.hasEntitlement('user-1', 'pitch-deck')).toBe(false);
  });

  it('revokes a previously granted entitlement', async () => {
    const store = createInMemoryEntitlementStore();
    const service = createEntitlementsService({ store });

    await service.grant('user-1', 'spec-pack', { source: 'purchase', reference: 'cs_test_1' });
    await service.revoke('user-1', 'spec-pack', { source: 'refund', reference: 're_test_1' });

    expect(await service.hasEntitlement('user-1', 'spec-pack')).toBe(false);
  });

  it('lists every tier a user owns', async () => {
    const store = createInMemoryEntitlementStore();
    const service = createEntitlementsService({ store });

    await service.grant('user-1', 'spec-pack', { source: 'purchase', reference: 'cs_1' });
    await service.grant('user-1', 'pitch-deck', { source: 'purchase', reference: 'cs_2' });

    const owned = await service.listEntitlements('user-1');

    expect(owned.sort()).toEqual(['pitch-deck', 'spec-pack']);
  });

  it('supports an admin override grant, distinguishable in the audit trail from a real purchase', async () => {
    const store = createInMemoryEntitlementStore();
    const service = createEntitlementsService({ store });

    await service.grant('user-1', 'financial-pack', {
      source: 'admin_override',
      reference: 'support-ticket-42',
    });

    expect(await service.hasEntitlement('user-1', 'financial-pack')).toBe(true);
    const records = await store.listByUser('user-1');
    expect(records).toContainEqual(
      expect.objectContaining({
        tierId: 'financial-pack',
        source: 'admin_override',
        reference: 'support-ticket-42',
      }),
    );
  });

  it('serves lookups from an in-memory cache rather than hitting the store on every call', async () => {
    const store = createInMemoryEntitlementStore();
    const listByUserSpy = vi.spyOn(store, 'listByUser');
    const service = createEntitlementsService({ store });

    await service.grant('user-1', 'spec-pack', { source: 'purchase', reference: 'cs_1' });
    listByUserSpy.mockClear();

    await service.hasEntitlement('user-1', 'spec-pack');
    await service.hasEntitlement('user-1', 'spec-pack');
    await service.hasEntitlement('user-1', 'pitch-deck');

    // The cache was populated by the grant call above; repeated lookups for
    // the same user should not each re-read the store.
    expect(listByUserSpy).not.toHaveBeenCalled();
  });

  it('invalidates the cache immediately on grant so a fresh purchase is reflected right away', async () => {
    const store = createInMemoryEntitlementStore();
    const service = createEntitlementsService({ store });

    expect(await service.hasEntitlement('user-1', 'spec-pack')).toBe(false);
    await service.grant('user-1', 'spec-pack', { source: 'purchase', reference: 'cs_1' });
    expect(await service.hasEntitlement('user-1', 'spec-pack')).toBe(true);
  });

  it('invalidates the cache immediately on revoke', async () => {
    const store = createInMemoryEntitlementStore();
    const service = createEntitlementsService({ store });

    await service.grant('user-1', 'spec-pack', { source: 'purchase', reference: 'cs_1' });
    expect(await service.hasEntitlement('user-1', 'spec-pack')).toBe(true);

    await service.revoke('user-1', 'spec-pack', { source: 'refund', reference: 're_1' });
    expect(await service.hasEntitlement('user-1', 'spec-pack')).toBe(false);
  });

  it('exposes findGrantReference for looking up the Stripe subscription id behind a granted tier (#103)', async () => {
    const store = createInMemoryEntitlementStore();
    const service = createEntitlementsService({ store });

    await service.grant('user-1', 'app-refinement-topup', {
      source: 'purchase',
      reference: 'sub_123',
    });

    expect(await service.findGrantReference('user-1', 'app-refinement-topup')).toBe('sub_123');
  });
});

describe('createInMemoryEntitlementStore (#100)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('records grant and revoke as separate audit entries rather than overwriting', async () => {
    const store = createInMemoryEntitlementStore();

    await store.grant('user-1', 'spec-pack', { source: 'purchase', reference: 're_1' });
    await store.revoke('user-1', 'spec-pack', { source: 'refund', reference: 're_1' });

    const records = await store.listByUser('user-1');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ tierId: 'spec-pack', action: 'grant' });
    expect(records[1]).toMatchObject({ tierId: 'spec-pack', action: 'revoke' });
  });
});

describe('findLatestGrantReference (#103)', () => {
  it('returns the reference of the most recent grant for a tier the user owns', async () => {
    const store = createInMemoryEntitlementStore();

    await store.grant('user-1', 'app-refinement-topup', {
      source: 'purchase',
      reference: 'sub_first',
    });
    await store.revoke('user-1', 'app-refinement-topup', {
      source: 'subscription_cancel',
      reference: 'sub_first',
    });
    await store.grant('user-1', 'app-refinement-topup', {
      source: 'purchase',
      reference: 'sub_second',
    });

    const reference = await store.findLatestGrantReference('user-1', 'app-refinement-topup');
    expect(reference).toBe('sub_second');
  });

  it('returns null when the user never had this tier granted', async () => {
    const store = createInMemoryEntitlementStore();

    const reference = await store.findLatestGrantReference('user-1', 'app-refinement-topup');
    expect(reference).toBeNull();
  });
});

describe('findOtherUsersGrantedWithEmail (#107)', () => {
  it('flags a different user account granted the same tier under the same buyer email', async () => {
    const store = createInMemoryEntitlementStore();

    await store.grant('user-1', 'spec-pack', {
      source: 'purchase',
      reference: 'cs_1',
      buyerEmail: 'shared@example.com',
    });
    await store.grant('user-2', 'spec-pack', {
      source: 'purchase',
      reference: 'cs_2',
      buyerEmail: 'shared@example.com',
    });

    const others = await store.findOtherUsersGrantedWithEmail(
      'user-2',
      'spec-pack',
      'shared@example.com',
    );

    expect(others).toEqual(['user-1']);
  });

  it('does not flag the same user granted twice under their own email', async () => {
    const store = createInMemoryEntitlementStore();

    await store.grant('user-1', 'spec-pack', {
      source: 'purchase',
      reference: 'cs_1',
      buyerEmail: 'me@example.com',
    });
    await store.grant('user-1', 'spec-pack', {
      source: 'purchase',
      reference: 'cs_2',
      buyerEmail: 'me@example.com',
    });

    const others = await store.findOtherUsersGrantedWithEmail(
      'user-1',
      'spec-pack',
      'me@example.com',
    );

    expect(others).toEqual([]);
  });

  it('does not flag a different email, even across different users', async () => {
    const store = createInMemoryEntitlementStore();

    await store.grant('user-1', 'spec-pack', {
      source: 'purchase',
      reference: 'cs_1',
      buyerEmail: 'one@example.com',
    });
    await store.grant('user-2', 'spec-pack', {
      source: 'purchase',
      reference: 'cs_2',
      buyerEmail: 'two@example.com',
    });

    const others = await store.findOtherUsersGrantedWithEmail(
      'user-2',
      'spec-pack',
      'two@example.com',
    );

    expect(others).toEqual([]);
  });
});

describe('entitlements service — entitlement sharing detection (#107)', () => {
  it('exposes findSharedAccounts for a service-layer caller to check for duplicate-account sharing', async () => {
    const store = createInMemoryEntitlementStore();
    const service = createEntitlementsService({ store });

    await service.grant('user-1', 'spec-pack', {
      source: 'purchase',
      reference: 'cs_1',
      buyerEmail: 'shared@example.com',
    });
    await service.grant('user-2', 'spec-pack', {
      source: 'purchase',
      reference: 'cs_2',
      buyerEmail: 'shared@example.com',
    });

    const shared = await service.findSharedAccounts('user-2', 'spec-pack', 'shared@example.com');
    expect(shared).toEqual(['user-1']);
  });
});
