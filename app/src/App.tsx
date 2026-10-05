import { useEffect, useState } from 'react';
import { type Phase, BUDGET_OPTIONS, TECHNICAL_LEVEL_OPTIONS } from '@forge/shared';
import { Pill } from '@forge/shared/ui';
import { AccountMenu } from './components/AccountMenu.js';
import { AppShell } from './components/AppShell.js';
import { AppRenderer } from './components/AppRenderer.js';
import { AuthGate } from './components/AuthGate.js';
import { BuildProgress, type BuildStage } from './components/BuildProgress.js';
import { CanvasPane } from './components/CanvasPane.js';
import { ChatInput } from './components/ChatInput.js';
import { ChatPane, type ChatMessage } from './components/ChatPane.js';
import { Onboarding } from './components/Onboarding.js';
import { PhaseRail } from './components/PhaseRail.js';
import { RefineGate } from './components/RefineGate.js';
import { StatusIndicators } from './components/StatusIndicators.js';
import { VersionHistory } from './components/VersionHistory.js';
import { applyTurnEvents, type TurnEvent } from './turn-events.js';
import {
  getLatestSession,
  createSession,
  getSession,
  listSessions,
  triggerBuild,
  sendMessage,
  refineApp,
  isGateReached,
  isRateLimited,
  isUnsafeRequest,
  getAppArtifact,
  revertAppVersion,
  selectBuildOption,
  lockArchitecture,
  lockCostTable,
  selectMarketingPlan,
  getGateStatus,
  confirmBuild,
  type AuthUser,
  type ApiSession,
  type ApiSessionCard,
  type BuildOptionsCardContent,
  type ArchitectureCardContent,
  type CostTableCardContent,
  type MarketingPlansCardContent,
} from './api.js';
import { BuildOptionsCard } from './components/BuildOptionsCard.js';
import { ArchitectureCard } from './components/ArchitectureCard.js';
import { AdvisorCard } from './components/AdvisorCard.js';
import {
  isAdvisorContent,
  isPaywallContent,
  type AdvisorCardContent,
} from './components/advisor-content.js';
import { PaywallCard } from './components/PaywallCard.js';
import { CostTableCard } from './components/CostTableCard.js';
import { MarketingPlansCard } from './components/MarketingPlansCard.js';
import { ConfirmBuildGate } from './components/ConfirmBuildGate.js';

type Health = { status: string; env: string } | null;

/** Live server status indicator for the top bar aside (placeholder until Epic 1.11). */
function HealthIndicator() {
  const [health, setHealth] = useState<Health>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/health')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setHealth)
      .catch(() => setError(true));
  }, []);

  const tone = error ? 'danger' : health ? 'success' : 'neutral';
  const label = error ? 'offline' : health ? health.env : 'connecting…';
  return <Pill tone={tone}>{label}</Pill>;
}

type SessionBootstrapState =
  | { status: 'checking' }
  | { status: 'unauthenticated' }
  | { status: 'ready'; session: ApiSession };

/**
 * Session bootstrap (Epic 0.8/1.10 frontend counterpart): on load, checks
 * for an authenticated session via the real httpOnly cookie the backend
 * already issues. Anonymous -> AuthGate; once authenticated, resumes the
 * user's latest session or creates a new one. Also exposes `switchSession`
 * (jump straight to an already-known session, e.g. from the account menu's
 * project list) and `startNewProject` (always creates a fresh session,
 * mirroring the very first "no sessions yet" bootstrap path on purpose) —
 * `signOut` is handled by the caller resetting straight to
 * `unauthenticated`, since the sign-out network call itself lives in the
 * account menu component.
 */
function useSessionBootstrap() {
  const [state, setState] = useState<SessionBootstrapState>({ status: 'checking' });

  async function resumeOrCreateSession() {
    const latest = await getLatestSession();
    if (latest.ok && latest.data) {
      setState({ status: 'ready', session: latest.data });
      return;
    }
    if (!latest.ok && latest.error.error !== 'unauthenticated') {
      // Any error other than "not signed in" still means we have no session
      // to act on, but leaves state as-is rather than guessing — surfaced
      // via the unauthenticated view's own retry (sign in again).
      setState({ status: 'unauthenticated' });
      return;
    }
    if (!latest.ok) {
      setState({ status: 'unauthenticated' });
      return;
    }

    const created = await createSession();
    if (created.ok) {
      setState({ status: 'ready', session: created.data });
    } else {
      setState({ status: 'unauthenticated' });
    }
  }

  useEffect(() => {
    resumeOrCreateSession();
  }, []);

  function handleAuthenticated(_user: AuthUser) {
    setState({ status: 'checking' });
    resumeOrCreateSession();
  }

  function handleSignedOut() {
    setState({ status: 'unauthenticated' });
  }

  function switchSession(session: ApiSession) {
    setState({ status: 'ready', session });
  }

  async function startNewProject() {
    const created = await createSession();
    if (created.ok) {
      setState({ status: 'ready', session: created.data });
    }
  }

  return { state, handleAuthenticated, handleSignedOut, switchSession, startNewProject };
}

/**
 * Build trigger + progress + preview (Epic 4, wiring the generation
 * pipeline into the browser for the first time): once a session has
 * reached the `build` phase, the manifest is already frozen (#61) and a
 * build can be requested. Shows BuildProgress (#73) while in flight and
 * AppRenderer (#68) once code comes back.
 */
function BuildPanel({
  sessionId,
  appRefinement,
  onAppRoundUsed,
}: {
  sessionId: string;
  /** Current app-stream round state (Epic 5.10) — seeds the gate immediately on resume, without waiting for a failed refine call to discover it. */
  appRefinement: { rounds: number; limit: number };
  /** Bubbles the fresh round count up so the top-bar meter (#86) stays live without a full session refetch. */
  onAppRoundUsed: (rounds: number) => void;
}) {
  const [stage, setStage] = useState<BuildStage>('compiling');
  const [error, setError] = useState<string | undefined>(undefined);
  const [app, setApp] = useState<{ code: string; compiledCode: string } | null>(null);
  const [building, setBuilding] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineNote, setRefineNote] = useState<string | null>(null);
  const [gate, setGate] = useState<{ rounds: number; limit: number } | null>(
    appRefinement.rounds >= appRefinement.limit ? appRefinement : null,
  );
  const [versionsRefreshKey, setVersionsRefreshKey] = useState(0);
  const [reverting, setReverting] = useState(false);

  // Session resume (Epic 5.10): the rendered app previously lived only in
  // this component's local state, so a page reload after a real build had
  // no way to get the code back short of triggering a brand new build.
  // Fetches the session's existing active artifact once on mount, if any.
  useEffect(() => {
    let cancelled = false;
    getAppArtifact(sessionId).then((result) => {
      if (!cancelled && result.ok) {
        setApp({ code: result.code, compiledCode: result.compiledCode });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function runBuild() {
    setBuilding(true);
    setError(undefined);
    setApp(null);
    setStage('compiling');

    // The build route (#75) runs synchronously end to end server-side —
    // there's no intermediate progress event stream yet (that's #73's own
    // follow-up once streaming exists), so the stages advance optimistically
    // while the single request is in flight rather than sitting on
    // "compiling" for the whole duration.
    setStage('generating');
    const result = await triggerBuild(sessionId);
    setBuilding(false);

    if (!result.ok) {
      setStage('validating');
      setError(result.reason ?? result.error);
      return;
    }

    setStage('rendering');
    setApp({ code: result.code, compiledCode: result.compiledCode });
    setStage('done');
    setVersionsRefreshKey((k) => k + 1);
  }

  async function handleRevert(version: number) {
    setReverting(true);
    const result = await revertAppVersion(sessionId, version);
    setReverting(false);

    if (result.ok) {
      setApp({ code: result.code, compiledCode: result.compiledCode });
      setGate(null);
      setVersionsRefreshKey((k) => k + 1);
    }
  }

  async function runRefine(changeRequest: string) {
    setRefining(true);
    setRefineNote(null);
    const result = await refineApp(sessionId, changeRequest);
    setRefining(false);

    if (isGateReached(result)) {
      setGate({ rounds: result.rounds ?? 0, limit: result.limit ?? 0 });
      return;
    }

    if (isRateLimited(result)) {
      const seconds = Math.ceil((result.retryAfterMs ?? 0) / 1000);
      setRefineNote(`Just a moment — try again in ${seconds}s.`);
      return;
    }

    if (isUnsafeRequest(result)) {
      setRefineNote(
        "That request couldn't be processed — try describing the app change you'd like instead.",
      );
      return;
    }

    if (!result.ok) {
      setRefineNote(result.reason ?? result.error);
      return;
    }

    if (result.kind === 'clarification') {
      setRefineNote(result.answer);
      return;
    }

    if (result.kind === 'scope_confirmation_needed') {
      const list = result.detectedChanges.map((c) => `• ${c}`).join('\n');
      setRefineNote(
        `That looks like ${result.detectedChanges.length} separate changes:\n${list}\nTry sending them one at a time.`,
      );
      return;
    }

    setApp({ code: result.code, compiledCode: result.compiledCode });
    onAppRoundUsed(result.rounds);
    setVersionsRefreshKey((k) => k + 1);
  }

  if (app) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            padding: 'var(--forge-space-2) var(--forge-space-4)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--forge-space-3)',
          }}
        >
          <a
            href={`/api/sessions/${sessionId}/export`}
            download
            style={{ color: 'var(--forge-signal-amber)', fontSize: '0.9rem' }}
          >
            Download as .jsx
          </a>
          <a
            href={`/api/sessions/${sessionId}/export/summary`}
            download
            style={{ color: 'var(--forge-signal-amber)', fontSize: '0.9rem' }}
          >
            Download plan summary
          </a>
          {refining && (
            <span style={{ color: 'var(--forge-slate-300)', fontSize: '0.85rem' }}>
              Applying your change…
            </span>
          )}
          {refineNote && !refining && (
            <span
              style={{
                color: 'var(--forge-slate-300)',
                fontSize: '0.85rem',
                whiteSpace: 'pre-line',
              }}
            >
              {refineNote}
            </span>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <AppRenderer compiledCode={app.compiledCode} />
        </div>
        <VersionHistory
          sessionId={sessionId}
          refreshKey={versionsRefreshKey}
          onRevert={handleRevert}
          reverting={reverting}
        />
        {gate ? (
          <RefineGate sessionId={sessionId} rounds={gate.rounds} limit={gate.limit} />
        ) : (
          <ChatInput phase="refine" onSend={runRefine} disabled={refining} />
        )}
      </div>
    );
  }

  if (building || error) {
    return <BuildProgress stage={stage} error={error} onRetry={runBuild} />;
  }

  return (
    <div style={{ padding: 'var(--forge-space-6)' }}>
      <p style={{ color: 'var(--forge-slate-300)', marginBottom: 'var(--forge-space-4)' }}>
        Your plan is locked in — ready to build your prototype.
      </p>
      <button
        type="button"
        onClick={runBuild}
        style={{
          padding: 'var(--forge-space-3) var(--forge-space-6)',
          borderRadius: 'var(--forge-radius-md)',
          border: 'none',
          background: 'var(--forge-signal-amber)',
          color: 'var(--forge-ink-900)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Build my app
      </button>
    </div>
  );
}

/**
 * App root. Renders the two-pane shell (Epic 1.1); the chat and canvas panes are
 * placeholders that later Epic 1 issues fill in.
 */
export function App() {
  const {
    state: sessionState,
    handleAuthenticated,
    handleSignedOut,
    switchSession,
    startNewProject,
  } = useSessionBootstrap();
  const [onboarded, setOnboarded] = useState(false);
  const [turnState, setTurnState] = useState({
    phase: 'onboarding' as Phase,
    cardIds: [] as string[],
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [cards, setCards] = useState<ApiSessionCard[]>([]);
  const [selectingOption, setSelectingOption] = useState(false);
  const [lockingArchitecture, setLockingArchitecture] = useState(false);
  const [lockingCostTable, setLockingCostTable] = useState(false);
  const [selectingMarketingPlan, setSelectingMarketingPlan] = useState(false);
  const [gateMissing, setGateMissing] = useState<string[] | null>(null);
  const [confirmingBuild, setConfirmingBuild] = useState(false);
  const [confirmBuildError, setConfirmBuildError] = useState<string | null>(null);

  // Seed turnState.phase from the real session once it becomes available,
  // then let handleTurnEvents (below, driven by real message responses) own
  // it from there — never read session.phase directly for rendering, since
  // that would go stale the instant a turn changes phase without a full
  // session refetch. Tracks *which* session was last seeded (rather than a
  // plain boolean) so switching projects — a new session id arriving into
  // the same mounted component — re-seeds instead of being silently
  // skipped as "already done".
  const [seededSessionId, setSeededSessionId] = useState<string | null>(null);
  const activeSessionIdForSeeding =
    sessionState.status === 'ready' ? sessionState.session.id : null;
  if (sessionState.status === 'ready' && seededSessionId !== activeSessionIdForSeeding) {
    setSeededSessionId(activeSessionIdForSeeding);
    setTurnState({ phase: sessionState.session.phase, cardIds: [] });
    // Replays the stored transcript into the chat pane on resume — without
    // this, a refresh showed "No messages yet" even though the server had
    // the full conversation, since only phase/onboarded state was ever
    // seeded from the resumed session.
    setMessages(sessionState.session.chat);
    // A session counts as "onboarded" (past the guided intro form) once
    // phase has advanced OR a real conversation has already started —
    // the agent's first onboarding turns ask clarifying questions before
    // ever transitioning phase, so phase alone would re-show the guided
    // form on every refresh during that stretch even though the user
    // already handed off their answers.
    setOnboarded(
      sessionState.session.phase !== 'onboarding' || sessionState.session.chatMessageCount > 0,
    );
    setCards(sessionState.session.cards);
  }
  const phase = turnState.phase;

  useEffect(() => {
    if (sessionState.status === 'ready') {
      listSessions().then((result) => {
        if (result.ok) setSessions(result.data);
      });
    } else {
      setSessions([]);
    }
  }, [activeSessionIdForSeeding, sessionState.status]);

  // Confirm-build gate (Epic 3.7): refetches whenever a card lock/select
  // changes `cards`, so the checklist and button state never go stale after
  // e.g. clicking "Confirm build" straight off a click-to-lock action.
  useEffect(() => {
    if (sessionState.status === 'ready' && phase === 'planning') {
      getGateStatus(sessionState.session.id).then((status) => {
        setGateMissing(status.next === 'build' ? status.missing : []);
      });
    } else {
      setGateMissing(null);
    }
  }, [sessionState.status, activeSessionIdForSeeding, phase, cards]);

  /**
   * Applies a turn's ordered events (Epic 2.12) — phase transitions and card
   * emissions — to local state in order, in the exact sequence they occurred.
   */
  function handleTurnEvents(events: TurnEvent[]) {
    setTurnState((prev) => applyTurnEvents(prev, events));
  }
  // Refinement round state (Epic 2.11, live-wired in #86): seeded from the
  // real session (server-tracked, #38) alongside the phase, then kept
  // current locally as refine-app calls (#76/#85/#89) report fresh round
  // counts — mirrors the seededSessionId re-seed-on-switch pattern above
  // rather than refetching the whole session after every refinement.
  const [refinement, setRefinement] = useState({
    app: { rounds: 0, limit: 3 },
    marketing: { rounds: 0, limit: 3 },
  });
  if (sessionState.status === 'ready' && seededSessionId !== activeSessionIdForSeeding) {
    const { session } = sessionState;
    setRefinement({
      app: { rounds: session.appRefinementRounds, limit: session.refinementLimits.app },
      marketing: {
        rounds: session.marketingRefinementRounds,
        limit: session.refinementLimits.marketing,
      },
    });
  }

  function handleAppRoundUsed(rounds: number) {
    setRefinement((prev) => ({ ...prev, app: { ...prev.app, rounds } }));
  }

  async function handleSend(text: string) {
    if (sessionState.status !== 'ready') return;
    const sessionId = sessionState.session.id;

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text }]);
    setSending(true);

    const result = await sendMessage(sessionId, text);

    setSending(false);
    if (!result.ok) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'agent',
          text: "I ran into trouble sending that — let's try again.",
        },
      ]);
      return;
    }

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'agent', text: result.reply },
    ]);
    handleTurnEvents(result.events);

    // card_emitted only carries {cardId, cardType} (turn-events.ts) — no
    // content — so a turn that touched any card refetches the session to
    // pick up the real card content rather than trying to thread it through
    // the event payload itself.
    if (result.events.some((event) => event.type === 'card_emitted')) {
      const refreshed = await getSession(sessionId);
      if (refreshed.ok) setCards(refreshed.data.cards);
    }
  }

  async function handleSelectBuildOption(index: number) {
    if (sessionState.status !== 'ready') return;
    setSelectingOption(true);
    const result = await selectBuildOption(sessionState.session.id, index);
    setSelectingOption(false);
    if (result.ok) {
      setCards((prev) => prev.map((c) => (c.type === 'options' ? result.card : c)));
    }
  }

  async function handleLockArchitecture() {
    if (sessionState.status !== 'ready') return;
    setLockingArchitecture(true);
    const result = await lockArchitecture(sessionState.session.id);
    setLockingArchitecture(false);
    if (result.ok) {
      setCards((prev) => prev.map((c) => (c.type === 'architecture' ? result.card : c)));
    }
  }

  async function handleLockCostTable() {
    if (sessionState.status !== 'ready') return;
    setLockingCostTable(true);
    const result = await lockCostTable(sessionState.session.id);
    setLockingCostTable(false);
    if (result.ok) {
      setCards((prev) => prev.map((c) => (c.type === 'cost' ? result.card : c)));
    }
  }

  async function handleSelectMarketingPlan(index: number) {
    if (sessionState.status !== 'ready') return;
    setSelectingMarketingPlan(true);
    const result = await selectMarketingPlan(sessionState.session.id, index);
    setSelectingMarketingPlan(false);
    if (result.ok) {
      setCards((prev) => prev.map((c) => (c.type === 'marketing' ? result.card : c)));
    }
  }

  async function handleConfirmBuild() {
    if (sessionState.status !== 'ready') return;
    setConfirmingBuild(true);
    setConfirmBuildError(null);
    const result = await confirmBuild(sessionState.session.id);
    setConfirmingBuild(false);
    if (result.ok) {
      handleTurnEvents([{ type: 'phase_changed', from: phase, to: 'build' }]);
    } else {
      setConfirmBuildError(
        result.error === 'phase_gate_not_satisfied'
          ? "Not all planning cards are locked yet — that shouldn't happen from this button, please refresh."
          : "Couldn't confirm the build — try again.",
      );
    }
  }

  if (sessionState.status === 'checking') {
    return null;
  }

  if (sessionState.status === 'unauthenticated') {
    return <AuthGate onAuthenticated={handleAuthenticated} />;
  }

  const sessionId = sessionState.session.id;
  const readyToBuild = phase === 'build' || phase === 'refine';
  const advisorCards = cards.filter(
    (card) => isAdvisorContent(card.content) || isPaywallContent(card.content),
  );

  return (
    <AppShell
      rail={<PhaseRail current={phase} />}
      aside={
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--forge-space-2)' }}>
          <StatusIndicators
            app={refinement.app}
            marketing={refinement.marketing}
            entitlement="free"
          />
          <HealthIndicator />
          <AccountMenu
            onSignedOut={handleSignedOut}
            sessions={sessions}
            activeSessionId={sessionId}
            onSelectSession={(id) => {
              const target = sessions.find((s) => s.id === id);
              if (target) switchSession(target);
            }}
            onNewProject={startNewProject}
          />
        </div>
      }
      chat={
        <div className="chat-column">
          <ChatPane messages={messages} pending={sending} />
          <ChatInput phase={phase} onSend={handleSend} disabled={sending} />
        </div>
      }
      canvas={
        readyToBuild ? (
          <>
            <BuildPanel
              sessionId={sessionId}
              appRefinement={refinement.app}
              onAppRoundUsed={handleAppRoundUsed}
            />
            {advisorCards.length > 0 && (
              <div className="advisor-stack" aria-label="Agent deliverables">
                {advisorCards.map((card, i) =>
                  isPaywallContent(card.content) ? (
                    <PaywallCard
                      key={card.id}
                      index={i + 1}
                      content={card.content}
                      sessionId={sessionId}
                    />
                  ) : (
                    <AdvisorCard
                      key={card.id}
                      index={i + 1}
                      status={card.status}
                      content={card.content as AdvisorCardContent}
                      accent="success"
                    />
                  ),
                )}
              </div>
            )}
          </>
        ) : onboarded ? (
          <CanvasPane>
            {cards.map((card, i) => {
              if (card.type === 'options') {
                return (
                  <BuildOptionsCard
                    key={card.id}
                    index={i + 1}
                    status={card.status}
                    content={card.content as BuildOptionsCardContent}
                    onSelect={handleSelectBuildOption}
                    selecting={selectingOption}
                  />
                );
              }
              if (card.type === 'architecture') {
                return (
                  <ArchitectureCard
                    key={card.id}
                    index={i + 1}
                    status={card.status}
                    content={card.content as ArchitectureCardContent}
                    onLock={handleLockArchitecture}
                    locking={lockingArchitecture}
                  />
                );
              }
              if (card.type === 'cost') {
                return (
                  <CostTableCard
                    key={card.id}
                    index={i + 1}
                    status={card.status}
                    content={card.content as CostTableCardContent}
                    onLock={handleLockCostTable}
                    locking={lockingCostTable}
                  />
                );
              }
              if (card.type === 'marketing') {
                return (
                  <MarketingPlansCard
                    key={card.id}
                    index={i + 1}
                    status={card.status}
                    content={card.content as MarketingPlansCardContent}
                    onSelect={handleSelectMarketingPlan}
                    selecting={selectingMarketingPlan}
                  />
                );
              }
              if (isAdvisorContent(card.content)) {
                return (
                  <AdvisorCard
                    key={card.id}
                    index={i + 1}
                    status={card.status}
                    content={card.content}
                    accent="planning"
                  />
                );
              }
              return null;
            })}
            {gateMissing !== null && (
              <ConfirmBuildGate
                missing={gateMissing}
                onConfirm={handleConfirmBuild}
                confirming={confirmingBuild}
                error={confirmBuildError}
              />
            )}
          </CanvasPane>
        ) : (
          <Onboarding
            onComplete={(responses) => {
              setOnboarded(true);
              const budgetLabel =
                BUDGET_OPTIONS.find((o) => o.value === responses.budget)?.label ?? responses.budget;
              const technicalLabel =
                TECHNICAL_LEVEL_OPTIONS.find((o) => o.value === responses.technicalLevel)?.label ??
                responses.technicalLevel;
              handleSend(
                `${responses.idea}\n\nIndustry: ${responses.industry}\nBudget: ${budgetLabel}\nHow technical I am: ${technicalLabel}\nWhat I want out of this: ${responses.goal}`,
              );
            }}
          />
        )
      }
    />
  );
}
