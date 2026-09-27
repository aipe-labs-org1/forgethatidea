import { describe, it, expect } from 'vitest';
import {
  createDisclaimerAcceptanceService,
  createInMemoryDisclaimerAcceptanceStore,
} from './disclaimer-acceptance.js';

describe('disclaimer acceptance service (#105)', () => {
  it('reports not accepted for a user who has never accepted', async () => {
    const store = createInMemoryDisclaimerAcceptanceStore();
    const service = createDisclaimerAcceptanceService({ store });

    const accepted = await service.hasAccepted('user-1', 'financial-pack-assumptions', '2026-01.1');
    expect(accepted).toBe(false);
  });

  it('reports accepted after recording acceptance at the current version', async () => {
    const store = createInMemoryDisclaimerAcceptanceStore();
    const service = createDisclaimerAcceptanceService({ store });

    await service.recordAcceptance('user-1', 'financial-pack-assumptions', '2026-01.1');

    expect(await service.hasAccepted('user-1', 'financial-pack-assumptions', '2026-01.1')).toBe(
      true,
    );
  });

  it('requires re-acceptance when the disclaimer version changes', async () => {
    const store = createInMemoryDisclaimerAcceptanceStore();
    const service = createDisclaimerAcceptanceService({ store });

    await service.recordAcceptance('user-1', 'financial-pack-assumptions', '2026-01.1');

    expect(await service.hasAccepted('user-1', 'financial-pack-assumptions', '2026-02.1')).toBe(
      false,
    );
  });

  it('scopes acceptance per user and per disclaimer id', async () => {
    const store = createInMemoryDisclaimerAcceptanceStore();
    const service = createDisclaimerAcceptanceService({ store });

    await service.recordAcceptance('user-1', 'financial-pack-assumptions', '2026-01.1');

    expect(await service.hasAccepted('user-2', 'financial-pack-assumptions', '2026-01.1')).toBe(
      false,
    );
    expect(await service.hasAccepted('user-1', 'other-disclaimer', '2026-01.1')).toBe(false);
  });

  it('records each acceptance with user, disclaimer id, version, and timestamp (#105)', async () => {
    const store = createInMemoryDisclaimerAcceptanceStore();

    await store.record('user-1', 'financial-pack-assumptions', '2026-01.1');

    const records = await store.listByUser('user-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      userId: 'user-1',
      disclaimerId: 'financial-pack-assumptions',
      version: '2026-01.1',
    });
    expect(records[0]!.acceptedAt).toBeInstanceOf(Date);
  });

  it('keeps every acceptance as a separate audit entry rather than overwriting on re-acceptance', async () => {
    const store = createInMemoryDisclaimerAcceptanceStore();

    await store.record('user-1', 'financial-pack-assumptions', '2026-01.1');
    await store.record('user-1', 'financial-pack-assumptions', '2026-02.1');

    const records = await store.listByUser('user-1');
    expect(records).toHaveLength(2);
  });
});
