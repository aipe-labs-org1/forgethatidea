import { describe, it, expect, vi } from 'vitest';
import { createAdvisorModule, type AdvisorSpec } from './advisor-module.js';
import { createInMemorySessionStore } from '../session-store.js';
import { createInMemoryManifestStore } from '../manifest-store.js';
import type { ModuleToolDeps } from './module-types.js';
import type { SessionCard } from '../phase-gates.js';

const SPEC: AdvisorSpec = {
  id: 'launch',
  label: 'Launch plan',
  minPhase: 'refine',
  guidance: 'Plan the launch.',
  requiredSections: [
    { key: 'channels', label: 'Launch channels' },
    { key: 'timeline', label: 'Timeline' },
  ],
};

const PAID_SPEC: AdvisorSpec = {
  ...SPEC,
  id: 'pitch-deck',
  label: 'Pitch deck',
  tierId: 'pitch-deck',
};

const VALID_INPUT = {
  summary: 'Launch on Product Hunt first, then communities.',
  sections: [
    { key: 'channels', title: 'Channels', body: 'Product Hunt, Indie Hackers.' },
    {
      key: 'timeline',
      title: 'Timeline',
      body: 'Week 1 soft launch, week 2 PH.',
      items: ['W1', 'W2'],
    },
  ],
  assumptions: ['Founder has 500 followers'],
  sources: [{ title: 'Product Hunt', url: 'https://www.producthunt.com' }],
};

async function setup(
  phase: 'planning' | 'refine' = 'refine',
  hasEntitlement?: ModuleToolDeps['hasEntitlement'],
) {
  const sessionStore = createInMemorySessionStore();
  const session = await sessionStore.create('user-1');
  await sessionStore.update(session.id, { phase });
  const onEvent = vi.fn();
  const deps: ModuleToolDeps = {
    sessionStore,
    manifestStore: createInMemoryManifestStore(),
    sessionId: session.id,
    userId: 'user-1',
    onEvent,
    hasEntitlement,
  };
  return { sessionStore, sessionId: session.id, deps, onEvent };
}

describe('createAdvisorModule (build-agents)', () => {
  it('exposes one render tool named after the agent id, with a schema', () => {
    const module = createAdvisorModule(SPEC);
    expect(module.id).toBe('launch');
    expect(Object.keys(module.toolSchemas!())).toEqual(['render_launch']);
  });

  it('is active only once the session reaches its phase floor', async () => {
    const module = createAdvisorModule(SPEC);
    const { sessionStore, sessionId } = await setup('planning');
    expect(module.isActive((await sessionStore.get(sessionId))!)).toBe(false);
    await sessionStore.update(sessionId, { phase: 'refine' });
    expect(module.isActive((await sessionStore.get(sessionId))!)).toBe(true);
  });

  it('renders a card of its own type and emits card_emitted', async () => {
    const module = createAdvisorModule(SPEC);
    const { sessionStore, sessionId, deps, onEvent } = await setup();
    const result = await module.getTools(deps).render_launch!(VALID_INPUT);

    expect(result).toMatchObject({ ok: true });
    const cards = (await sessionStore.get(sessionId))!.cards as SessionCard[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: 'launch', status: 'draft' });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'card_emitted', cardType: 'launch' }),
    );
  });

  it('replaces its card in place on re-render, marking it refined', async () => {
    const module = createAdvisorModule(SPEC);
    const { sessionStore, sessionId, deps } = await setup();
    const tools = module.getTools(deps);
    await tools.render_launch!(VALID_INPUT);
    await tools.render_launch!({ ...VALID_INPUT, summary: 'Changed.' });

    const cards = (await sessionStore.get(sessionId))!.cards as SessionCard[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      status: 'refined',
      content: expect.objectContaining({ summary: 'Changed.' }),
    });
  });

  it('rejects input missing a required section, naming exactly what is missing', async () => {
    const module = createAdvisorModule(SPEC);
    const { deps } = await setup();
    const result = await module.getTools(deps).render_launch!({
      ...VALID_INPUT,
      sections: [VALID_INPUT.sections[0]],
    });
    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
    expect((result as { details: string[] }).details.join(' ')).toContain('timeline');
  });

  it('rejects a source without a real http(s) url', async () => {
    const module = createAdvisorModule(SPEC);
    const { deps } = await setup();
    const result = await module.getTools(deps).render_launch!({
      ...VALID_INPUT,
      sources: [{ title: 'Made up', url: 'not a url' }],
    });
    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('blocks a paid agent for a user who does not own its tier', async () => {
    const module = createAdvisorModule(PAID_SPEC);
    const { sessionStore, sessionId, deps } = await setup('refine', async () => false);
    const result = await module.getTools(deps)['render_pitch_deck']!(VALID_INPUT);

    expect(result).toMatchObject({ ok: false, error: 'not_entitled', tierId: 'pitch-deck' });
    const types = ((await sessionStore.get(sessionId))!.cards as SessionCard[]).map((c) => c.type);
    expect(types).not.toContain('pitch-deck');
  });

  it('allows a paid agent once the user owns its tier', async () => {
    const module = createAdvisorModule(PAID_SPEC);
    const hasEntitlement = vi.fn(async () => true);
    const { deps } = await setup('refine', hasEntitlement);
    const result = await module.getTools(deps)['render_pitch_deck']!(VALID_INPUT);

    expect(result).toMatchObject({ ok: true });
    expect(hasEntitlement).toHaveBeenCalledWith('user-1', 'pitch-deck');
  });

  it('includes required sections and the paywall note in its prompt guidance', async () => {
    const { sessionStore, sessionId } = await setup();
    const prompt = createAdvisorModule(PAID_SPEC).buildPrompt((await sessionStore.get(sessionId))!);
    expect(prompt).toContain('render_pitch_deck');
    expect(prompt).toContain('channels');
    expect(prompt).toMatch(/paid/i);
  });
});

describe('paywall card for paid agents', () => {
  const getTierProduct = (tierId: string) =>
    tierId === 'pitch-deck'
      ? { name: 'Pitch Deck', description: 'Investor deck from your plan.', priceCents: 2900 }
      : undefined;

  it('puts an unlock card for the tier on the canvas when the user is not entitled', async () => {
    const module = createAdvisorModule(PAID_SPEC);
    const { sessionStore, sessionId, deps, onEvent } = await setup('refine', async () => false);
    await module.getTools({ ...deps, getTierProduct })['render_pitch_deck']!(VALID_INPUT);

    const cards = (await sessionStore.get(sessionId))!.cards as SessionCard[];
    expect(cards).toEqual([
      expect.objectContaining({
        type: 'paywall:pitch-deck',
        content: {
          kind: 'paywall',
          tierId: 'pitch-deck',
          agentLabel: 'Pitch deck',
          tierName: 'Pitch Deck',
          description: 'Investor deck from your plan.',
          priceCents: 2900,
        },
      }),
    ]);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'card_emitted', cardType: 'paywall:pitch-deck' }),
    );
  });

  it('does not duplicate the unlock card on repeated refusals', async () => {
    const module = createAdvisorModule(PAID_SPEC);
    const { sessionStore, sessionId, deps } = await setup('refine', async () => false);
    const tool = module.getTools({ ...deps, getTierProduct })['render_pitch_deck']!;
    await tool(VALID_INPUT);
    await tool(VALID_INPUT);
    expect((await sessionStore.get(sessionId))!.cards as SessionCard[]).toHaveLength(1);
  });

  it('removes the unlock card once the tier is owned and the agent renders', async () => {
    const module = createAdvisorModule(PAID_SPEC);
    let owned = false;
    const { sessionStore, sessionId, deps } = await setup('refine', async () => owned);
    const tool = module.getTools({ ...deps, getTierProduct })['render_pitch_deck']!;
    await tool(VALID_INPUT);
    owned = true;
    await tool(VALID_INPUT);

    const types = ((await sessionStore.get(sessionId))!.cards as SessionCard[]).map((c) => c.type);
    expect(types).toEqual(['pitch-deck']);
  });
});
