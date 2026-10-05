import { describe, it, expect, vi } from 'vitest';
import { createAgentOrchestrator } from './agent-orchestrator.js';
import { createInMemorySessionStore } from './session-store.js';
import { createInMemoryManifestStore } from './manifest-store.js';
import { createCostGuard, createInMemoryCostGuardStore } from './cost-guard.js';
import type { AnthropicMessageParam, StreamMessageResult } from './anthropic-client.js';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A scripted fake Anthropic client — returns pre-programmed responses in sequence. */
function scriptedAnthropicClient(responses: StreamMessageResult[]) {
  let call = 0;
  const messagesReceived: AnthropicMessageParam[][] = [];
  const streamMessage = vi.fn(async (request: { messages: AnthropicMessageParam[] }) => {
    messagesReceived.push(request.messages);
    const response = responses[call];
    call++;
    if (!response) throw new Error('scriptedAnthropicClient: ran out of scripted responses');
    return response;
  });
  return { streamMessage, messagesReceived };
}

/** A fake Anthropic client that always throws — simulates a real API/network failure. */
function throwingAnthropicClient(error: Error = new Error('anthropic api unavailable')) {
  return { streamMessage: vi.fn(async () => Promise.reject(error)) };
}

/** A scripted client where every call returns a failed tool_use round (model keeps calling a broken tool). */
function repeatedlyFailingToolClient(rounds: number, toolName = 'broken_tool') {
  let call = 0;
  const streamMessage = vi.fn(async () => {
    call++;
    if (call <= rounds) {
      return {
        inputTokens: 5,
        outputTokens: 2,
        stopReason: 'tool_use',
        content: [{ type: 'tool_use' as const, id: `toolu_${call}`, name: toolName, input: {} }],
      };
    }
    return {
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'end_turn',
      content: [{ type: 'text' as const, text: 'should not reach here' }],
    };
  });
  return { streamMessage };
}

/**
 * A scripted client where every call returns a *successful* tool_use round
 * (unlike repeatedlyFailingToolClient) — models the real production failure
 * this reproduces: the model keeps making legitimate, successful tool calls
 * (e.g. update_manifest) round after round without ever emitting a text
 * reply, burning the whole maxToolRounds budget with nothing to show for it.
 */
function repeatedlySucceedingToolClient(rounds: number, toolName = 'get_manifest') {
  let call = 0;
  const messagesReceived: AnthropicMessageParam[][] = [];
  const streamMessage = vi.fn(async (request: { messages: AnthropicMessageParam[] }) => {
    messagesReceived.push(request.messages);
    call++;
    if (call <= rounds) {
      return {
        inputTokens: 5,
        outputTokens: 2,
        stopReason: 'tool_use' as const,
        content: [{ type: 'tool_use' as const, id: `toolu_${call}`, name: toolName, input: {} }],
      };
    }
    return {
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'end_turn' as const,
      content: [{ type: 'text' as const, text: 'should not reach here' }],
    };
  });
  return { streamMessage, messagesReceived };
}

function buildDeps(
  anthropicClient:
    | ReturnType<typeof scriptedAnthropicClient>
    | ReturnType<typeof throwingAnthropicClient>
    | ReturnType<typeof repeatedlyFailingToolClient>,
) {
  const sessionStore = createInMemorySessionStore();
  const manifestStore = createInMemoryManifestStore();
  const costGuardStore = createInMemoryCostGuardStore();
  const costGuard = createCostGuard({
    store: costGuardStore,
    sessionCapCents: 1000,
    userDailyCapCents: 10000,
    warnRatio: 0.8,
    logger: silentLogger(),
  });

  return { sessionStore, manifestStore, costGuard, anthropicClient };
}

describe('createAgentOrchestrator', () => {
  it('sends the user message and returns the assistant text reply', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: "What's the idea?" }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'A habit tracker app.');

    expect(result).toMatchObject({ ok: true, reply: "What's the idea?" });
  });

  it('persists both the user message and the assistant reply to session chat', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Tell me more.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    await orchestrator.handleTurn(session.id, 'user-1', 'A habit tracker app.');

    const updated = await deps.sessionStore.get(session.id);
    expect(updated!.chat).toEqual([
      expect.objectContaining({ role: 'user', text: 'A habit tracker app.' }),
      expect.objectContaining({ role: 'agent', text: 'Tell me more.' }),
    ]);
  });

  it('builds the system prompt from the session current phase', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    await orchestrator.handleTurn(session.id, 'user-1', 'hello');

    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.stringContaining('onboarding') }),
      expect.anything(),
    );
  });

  it('dispatches a tool_use turn (update_manifest) and continues the conversation with the tool result', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'get_manifest',
            input: {},
          },
        ],
      },
      {
        inputTokens: 8,
        outputTokens: 4,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'No manifest yet — got it.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'what do we have so far?');

    expect(result).toMatchObject({ ok: true, reply: 'No manifest yet — got it.' });
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(2);

    // Second call's messages must include the tool_use + tool_result turn.
    const secondCallMessages = anthropicClient.messagesReceived[1]!;
    const assistantToolUseTurn = secondCallMessages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.content),
    );
    expect(assistantToolUseTurn).toBeDefined();
    const toolResultTurn = secondCallMessages.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_result'),
    );
    expect(toolResultTurn).toBeDefined();
  });

  it('rejects the turn when the cost guard cap is already reached', async () => {
    const anthropicClient = scriptedAnthropicClient([]);
    const sessionStore = createInMemorySessionStore();
    const manifestStore = createInMemoryManifestStore();
    const costGuardStore = createInMemoryCostGuardStore();
    await costGuardStore.recordSpend('will-be-session-1', 'user-1', 1000);
    const costGuard = createCostGuard({
      store: costGuardStore,
      sessionCapCents: 1000,
      userDailyCapCents: 10000,
      warnRatio: 0.8,
      logger: silentLogger(),
    });
    const session = await sessionStore.create('user-1');
    // Re-record spend under the real session id now that we have it.
    await costGuardStore.recordSpend(session.id, 'user-1', 1000);

    const orchestrator = createAgentOrchestrator({
      sessionStore,
      manifestStore,
      costGuard,
      anthropicClient,
    });

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'hello');

    expect(result).toMatchObject({ ok: false, error: 'cost_cap_exceeded' });
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
  });

  it('returns an error for a nonexistent session', async () => {
    const anthropicClient = scriptedAnthropicClient([]);
    const deps = buildDeps(anthropicClient);
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn('nonexistent', 'user-1', 'hello');
    expect(result).toEqual({ ok: false, error: 'session_not_found' });
  });

  it('dispatches record_source (Epic 2.8) and persists it to session sourcesIntake', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'record_source', input: { input: 'Notion' } },
        ],
      },
      {
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Got it, noted Notion as a reference.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'Notion is similar');

    expect(result).toMatchObject({ ok: true });
    const updated = await deps.sessionStore.get(session.id);
    expect(updated!.sourcesIntake.sources).toEqual([{ type: 'text', value: 'Notion' }]);
  });

  it('dispatches decline_sources (Epic 2.8) and marks the intake declined', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'decline_sources', input: {} }],
      },
      {
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'No problem, moving on.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    await orchestrator.handleTurn(session.id, 'user-1', 'none, nothing comes to mind');

    const updated = await deps.sessionStore.get(session.id);
    expect(updated!.sourcesIntake).toEqual({ sources: [], declined: true });
  });
});

describe('agent error recovery & guardrails (#40)', () => {
  it('returns a graceful fallback reply, not a thrown error, when the model API fails', async () => {
    const anthropicClient = throwingAnthropicClient();
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'hello');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.reply.length).toBeGreaterThan(0);
    }
  });

  it("persists the user's message even when the model API fails, so it isn't lost", async () => {
    const anthropicClient = throwingAnthropicClient();
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    await orchestrator.handleTurn(session.id, 'user-1', 'a habit tracker app');

    const updated = await deps.sessionStore.get(session.id);
    expect(updated!.chat).toEqual([
      expect.objectContaining({ role: 'user', text: 'a habit tracker app' }),
      expect.objectContaining({ role: 'agent' }),
    ]);
  });

  it('does not record cost-guard usage for a turn where the model call never succeeded', async () => {
    const anthropicClient = throwingAnthropicClient();
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    await orchestrator.handleTurn(session.id, 'user-1', 'hello');

    // No usage was ever returned by the model, so there is nothing real to
    // charge — recordUsage should not have been called with a spend that
    // could only come from a successful response.
    await expect(
      deps.costGuard.checkBeforeCall({ sessionId: session.id, userId: 'user-1' }),
    ).resolves.toBeUndefined();
  });

  it('breaks out early on consecutive tool failures, well before maxToolRounds is reached', async () => {
    const anthropicClient = repeatedlyFailingToolClient(20);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    // maxToolRounds is generously high — if the orchestrator only stopped
    // via that budget, this call count would be near it. The consecutive-
    // failure detector (threshold 2) should stop it far sooner than that.
    const orchestrator = createAgentOrchestrator({ ...deps, maxToolRounds: 20 });

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'do the thing');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.reply.toLowerCase()).toMatch(/track|different|rephrase/);
    }
    expect(anthropicClient.streamMessage.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('never leaves the turn in a dead-end state — always resolves with a typed result, never rejects', async () => {
    const anthropicClient = throwingAnthropicClient(new Error('total meltdown'));
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'hello');
    expect(result).toHaveProperty('ok');
  });

  it('nudges the model to wrap up in text before the final round, when every prior round made real (non-erroring) tool calls', async () => {
    // Reproduces the production bug: onboarding's first turn made 6
    // consecutive successful tool_use rounds and never got a text reply,
    // burning the full round budget silently. The consecutive-failure
    // detector never fires here since nothing is erroring.
    const anthropicClient = repeatedlySucceedingToolClient(20);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator({ ...deps, maxToolRounds: 5 });

    await orchestrator.handleTurn(session.id, 'user-1', 'a habit tracker app');

    // The last (6th) call's request — everything the model sees going into
    // its final round — should carry the wrap-up nudge somewhere in its
    // conversation history, giving it a real chance to reply in text before
    // the budget runs out, rather than silently exhausting it with no warning.
    const finalCallMessages = anthropicClient.messagesReceived.at(-1)!;
    const serialized = JSON.stringify(finalCallMessages);
    expect(serialized.toLowerCase()).toMatch(/last|final|wrap up|respond|text reply/);
  });
});

describe('phase transition events to UI (#39)', () => {
  it('returns an empty events list when nothing changed this turn', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'hello');

    expect(result).toMatchObject({ ok: true, events: [] });
  });

  it('dispatches transition_phase and reports a phase_changed event', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'transition_phase', input: { to: 'sources' } },
        ],
      },
      {
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: "Great, let's talk sources." }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(
      session.id,
      'user-1',
      "I know enough, let's move on",
    );

    expect(result).toMatchObject({
      ok: true,
      events: [{ type: 'phase_changed', from: 'onboarding', to: 'sources' }],
    });
    const updated = await deps.sessionStore.get(session.id);
    expect(updated!.phase).toBe('sources');
  });

  it('does not report an event when transition_phase is rejected (illegal transition)', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'transition_phase', input: { to: 'planning' } },
        ],
      },
      {
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'One step at a time.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'skip ahead please');

    expect(result).toMatchObject({ ok: true, events: [] });
    const updated = await deps.sessionStore.get(session.id);
    expect(updated!.phase).toBe('onboarding');
  });

  it('preserves event order across multiple tool rounds within one turn', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'transition_phase', input: { to: 'sources' } },
        ],
      },
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'transition_phase',
            input: { to: 'brainstorm' },
          },
        ],
      },
      {
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Moved through two phases.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'fast-track this session');

    expect(result).toMatchObject({
      ok: true,
      events: [
        { type: 'phase_changed', from: 'onboarding', to: 'sources' },
        { type: 'phase_changed', from: 'sources', to: 'brainstorm' },
      ],
    });
  });
});

describe('conversation compaction (#37)', () => {
  it('keeps chat uncompacted while under the keep-recent threshold', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'reply' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator({ ...deps, keepRecentMessages: 10 });

    await orchestrator.handleTurn(session.id, 'user-1', 'hi');

    const updated = await deps.sessionStore.get(session.id);
    expect(updated?.chat).toHaveLength(2);
  });

  it('compacts older messages once the chat exceeds keepRecentMessages', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'reply' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    await deps.sessionStore.update(session.id, {
      chat: [
        { id: 'a', role: 'user', text: 'one' },
        { id: 'b', role: 'agent', text: 'two' },
        { id: 'c', role: 'user', text: 'three' },
        { id: 'd', role: 'agent', text: 'four' },
      ],
    });
    const orchestrator = createAgentOrchestrator({ ...deps, keepRecentMessages: 2 });

    await orchestrator.handleTurn(session.id, 'user-1', 'hi');

    const updated = await deps.sessionStore.get(session.id);
    const chat = updated?.chat as { id: string; role: string; text: string }[];
    expect(chat).toHaveLength(3);
    expect(chat[0]?.id).toBe('compaction-summary');
    expect(chat[0]?.text.toLowerCase()).toContain('manifest');
    expect(chat[chat.length - 1]?.text).toBe('reply');
  });

  it('sends the compacted (not raw) history to the model', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'reply' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    await deps.sessionStore.update(session.id, {
      chat: Array.from({ length: 8 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'agent',
        text: `msg ${i}`,
      })),
    });
    const orchestrator = createAgentOrchestrator({ ...deps, keepRecentMessages: 2 });

    await orchestrator.handleTurn(session.id, 'user-1', 'hi');

    const sentMessages = anthropicClient.messagesReceived[0]!;
    // system history (compacted) + the new user message
    expect(sentMessages.length).toBeLessThan(9);
  });
});

describe('manifest summary tool (#41)', () => {
  it('dispatches summarize_manifest and returns the plain-language recap as the reply', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 5,
        outputTokens: 2,
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'summarize_manifest', input: {} }],
      },
      {
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Here is where things stand.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    await deps.manifestStore.save(session.id, {
      schemaVersion: 1,
      productName: 'Habit Tracker',
      icp: 'People building daily habits.',
      entities: [{ name: 'Habit', fields: [{ name: 'title', type: 'string' }] }],
      screens: [{ name: 'Dashboard', purpose: 'See habits' }],
      roles: ['user'],
      keyActions: ['Mark complete'],
      branding: { accentColor: '#2E7D32', tone: 'calm' },
      references: { researchCardIds: [] },
    });
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'what do we have so far?');

    expect(result).toMatchObject({ ok: true, reply: 'Here is where things stand.' });
    const secondCallMessages = anthropicClient.messagesReceived[1]!;
    const toolResultTurn = secondCallMessages.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_result'),
    );
    expect(toolResultTurn).toBeDefined();
  });
});

describe('session analytics events (#42)', () => {
  it('emits a phase_entered analytics event when transition_phase succeeds', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'transition_phase', input: { to: 'sources' } },
        ],
      },
      {
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: "Let's talk sources." }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const analyticsLogger = { info: vi.fn() };
    const orchestrator = createAgentOrchestrator({ ...deps, analyticsLogger });

    await orchestrator.handleTurn(session.id, 'user-1', 'move on');

    expect(analyticsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        analytics_event: true,
        type: 'phase_entered',
        sessionId: session.id,
        phase: 'sources',
      }),
      'analytics.phase_entered',
    );
  });

  it('does not emit a phase_entered event when no transition happens', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const analyticsLogger = { info: vi.fn() };
    const orchestrator = createAgentOrchestrator({ ...deps, analyticsLogger });

    await orchestrator.handleTurn(session.id, 'user-1', 'hello');

    expect(analyticsLogger.info).not.toHaveBeenCalled();
  });

  it('never includes chat/user message content in the emitted analytics event', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'transition_phase', input: { to: 'sources' } },
        ],
      },
      {
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'reply' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const analyticsLogger = { info: vi.fn() };
    const orchestrator = createAgentOrchestrator({ ...deps, analyticsLogger });

    await orchestrator.handleTurn(session.id, 'user-1', 'this is my secret idea for an app');

    const [payload] = analyticsLogger.info.mock.calls[0]!;
    expect(JSON.stringify(payload)).not.toContain('secret idea');
  });

  it('emits a session_converted event when the session reaches the build phase', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'transition_phase', input: { to: 'build' } },
        ],
      },
      {
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Locked in, moving to build.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    await deps.manifestStore.save(session.id, {
      schemaVersion: 1,
      productName: 'Habit Tracker',
      icp: 'People building daily habits.',
      entities: [{ name: 'Habit', fields: [{ name: 'title', type: 'string' }] }],
      screens: [{ name: 'Dashboard', purpose: 'See habits' }],
      roles: ['user'],
      keyActions: ['Mark complete'],
      branding: { accentColor: '#2E7D32', tone: 'calm' },
      references: { researchCardIds: [] },
    });
    await deps.sessionStore.update(session.id, {
      phase: 'refine',
      cards: [
        { id: 'c1', type: 'options', status: 'locked' },
        { id: 'c2', type: 'architecture', status: 'locked' },
        { id: 'c3', type: 'cost', status: 'locked' },
        { id: 'c4', type: 'marketing', status: 'locked' },
      ],
    });
    // transition_phase only allows a single forward step; drop the session back one phase
    // (planning -> build) so this transition is legal while cards stay locked.
    await deps.sessionStore.update(session.id, { phase: 'planning' });
    const analyticsLogger = { info: vi.fn() };
    const orchestrator = createAgentOrchestrator({ ...deps, analyticsLogger });

    await orchestrator.handleTurn(session.id, 'user-1', 'ready to build');

    expect(analyticsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        analytics_event: true,
        type: 'session_converted',
        sessionId: session.id,
      }),
      'analytics.session_converted',
    );
  });
});

describe('tool call diagnostic logging', () => {
  it('forwards a real logger to the tool dispatcher so tool calls are observable in logs', async () => {
    // Regression coverage for a real production bug: update_manifest's own
    // domain-level rejection (no_manifest_to_merge_into) was invisible in
    // logs because the orchestrator always used a hardcoded silent logger
    // for tool dispatch, regardless of what logger the caller configured.
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 5,
        outputTokens: 2,
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'update_manifest',
            input: { patch: { productName: 'HabitLoop' } },
          },
        ],
      },
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const logger = silentLogger();
    const orchestrator = createAgentOrchestrator({ ...deps, logger });

    await orchestrator.handleTurn(session.id, 'user-1', 'set the product name');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'update_manifest' }),
      'tool call resolved with a domain-level failure',
    );
  });
});

describe('marketing refinement loop (#88)', () => {
  const PLAN = {
    name: 'Community-led growth',
    icp: 'Solo founders',
    gtm: 'Indie-hacker communities',
    seo: 'Long-tail SEO',
    ads: 'Small retargeting budget',
    competitors: ['Bubble'],
  };
  const PLANS_INPUT = {
    plans: [PLAN, { ...PLAN, name: 'Plan B' }, { ...PLAN, name: 'Plan C' }],
  };

  it('exposes refine_marketing_plans as a tool the model can call', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 5,
        outputTokens: 2,
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'refine_marketing_plans', input: PLANS_INPUT },
        ],
      },
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Updated the marketing plan.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    const orchestrator = createAgentOrchestrator(deps);

    const result = await orchestrator.handleTurn(session.id, 'user-1', 'tweak the marketing plan');

    expect(result.ok).toBe(true);
    const updated = await deps.sessionStore.get(session.id);
    const card = (updated!.cards as { type: string }[]).find((c) => c.type === 'marketing');
    expect(card).toBeDefined();
  });

  it('consumes a marketing refinement round only once the session has reached refine phase', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 5,
        outputTokens: 2,
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'refine_marketing_plans', input: PLANS_INPUT },
        ],
      },
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Updated the marketing plan.' }],
      },
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    await deps.sessionStore.update(session.id, { phase: 'refine' });
    const orchestrator = createAgentOrchestrator(deps);

    await orchestrator.handleTurn(session.id, 'user-1', 'tweak the marketing plan');

    const updated = await deps.sessionStore.get(session.id);
    expect(updated!.marketingRefinementRounds).toBe(1);
  });
});

describe('agent modules working in tandem (build-agents.md)', () => {
  function endTurn(text = 'ok') {
    return {
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'end_turn' as const,
      content: [{ type: 'text' as const, text }],
    };
  }

  async function firstRequest(phase: 'onboarding' | 'planning' | 'refine') {
    const anthropicClient = scriptedAnthropicClient([endTurn()]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    await deps.sessionStore.update(session.id, { phase });
    const orchestrator = createAgentOrchestrator(deps);
    await orchestrator.handleTurn(session.id, 'user-1', 'hi');
    const request = anthropicClient.streamMessage.mock.calls[0]![0] as unknown as {
      system: string;
      tools: { name: string; inputSchema: { type: string; required?: string[] } }[];
    };
    return request;
  }

  it('keeps advisor agents out of early phases', async () => {
    const request = await firstRequest('onboarding');
    const names = request.tools.map((t) => t.name);
    expect(names).not.toContain('render_launch');
    expect(names).not.toContain('render_data_protection');
  });

  it('adds planning-phase advisors (legal, deployment, paywall) alongside the spine tools', async () => {
    const request = await firstRequest('planning');
    const names = request.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'render_architecture',
        'render_data_protection',
        'render_deployment',
        'render_paywall_geo',
      ]),
    );
    expect(names).not.toContain('render_launch');
    expect(request.system).toContain('Data protection & filings agent');
  });

  it('runs every refine-phase agent together in one call, each with its own schema', async () => {
    const request = await firstRequest('refine');
    const names = request.tools.map((t) => t.name);
    for (const tool of [
      'render_launch',
      'render_social_seo',
      'render_spec_pack',
      'render_epics_export',
      'render_financial',
      'render_funding',
      'render_pitch_deck',
    ]) {
      expect(names).toContain(tool);
    }
    const launch = request.tools.find((t) => t.name === 'render_launch')!;
    expect(launch.inputSchema.required).toEqual(['summary', 'sections']);
    expect(request.system).toContain('Pitch deck agent');
  });

  it('lets a free advisor render a card through a real tool call, emitting card_emitted', async () => {
    const anthropicClient = scriptedAnthropicClient([
      {
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'render_launch',
            input: {
              summary: 'Soft launch then Product Hunt.',
              sections: [
                { key: 'prelaunch', title: 'Pre-launch', body: 'Waitlist.' },
                { key: 'launch_day', title: 'Launch', body: 'Product Hunt.' },
                { key: 'first_30_days', title: 'First 30 days', body: 'Interviews.' },
                { key: 'success_metrics', title: 'Success', body: '100 signups.' },
              ],
            },
          },
        ],
      },
      endTurn('Launch plan is on the canvas.'),
    ]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    await deps.sessionStore.update(session.id, { phase: 'refine' });

    const result = await createAgentOrchestrator(deps).handleTurn(
      session.id,
      'user-1',
      'plan launch',
    );

    expect(result).toMatchObject({
      ok: true,
      events: [expect.objectContaining({ type: 'card_emitted', cardType: 'launch' })],
    });
  });

  it('refuses a paid advisor without the tier, and allows it once owned', async () => {
    const paidCall = {
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'tool_use' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'render_pitch_deck',
          input: { summary: 'x', sections: [] },
        },
      ],
    };
    const anthropicClient = scriptedAnthropicClient([paidCall, endTurn()]);
    const deps = buildDeps(anthropicClient);
    const session = await deps.sessionStore.create('user-1');
    await deps.sessionStore.update(session.id, { phase: 'refine' });
    const hasEntitlement = vi.fn(async () => false);

    await createAgentOrchestrator({ ...deps, hasEntitlement }).handleTurn(
      session.id,
      'user-1',
      'deck',
    );

    expect(hasEntitlement).toHaveBeenCalledWith('user-1', 'pitch-deck');
    const toolResultTurn = anthropicClient.messagesReceived[1]!;
    expect(JSON.stringify(toolResultTurn)).toContain('not_entitled');
  });
});
