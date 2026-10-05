import type { Phase } from '@forge/shared';
import type { TurnEvent } from './turn-events.js';

/**
 * Typed fetch wrappers for the real backend (Epic 0.8/1.10/4). Every call
 * sets `credentials: 'include'` since auth is an httpOnly session cookie
 * (routes/auth.ts), not a bearer token — the browser must be told to send
 * it on same-origin requests.
 */

export interface AuthUser {
  id: string;
  email: string;
}

export interface RefinementLimits {
  app: number;
  marketing: number;
}

export interface ApiChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
}

export interface BuildOption {
  name: string;
  summary: string;
}

export interface BuildOptionsCardContent {
  options: BuildOption[];
  selectedIndex: number | null;
}

export interface ApiSessionCard {
  id: string;
  type: string;
  status: 'draft' | 'refined' | 'locked' | 'live';
  content?: unknown;
}

export interface ArchitectureComponent {
  name: string;
  description: string;
}

export interface ArchitectureConnection {
  from: string;
  to: string;
  label: string;
}

export interface ArchitectureCardContent {
  summary: string;
  components: ArchitectureComponent[];
  connections: ArchitectureConnection[];
}

export interface CostLineItem {
  name: string;
  monthlyCostCents: number;
  assumption: string;
  sourceUrl: string;
}

export interface CostScale {
  label: string;
  lineItems: CostLineItem[];
  totalMonthlyCostCents: number;
  totalYearlyCostCents: number;
}

export interface CostTableCardContent {
  scales: CostScale[];
}

export interface MarketingPlan {
  name: string;
  icp: string;
  gtm: string;
  seo: string;
  ads: string;
  competitors: string[];
}

export interface MarketingPlansCardContent {
  plans: MarketingPlan[];
  selectedIndex: number | null;
}

export interface ApiSession {
  id: string;
  userId: string | null;
  phase: Phase;
  /** Full chat transcript so far — replayed into the chat pane on resume. */
  chat: ApiChatMessage[];
  /** Canvas deliverable cards (build options, architecture, cost, etc.) — rendered in the CanvasPane. */
  cards: ApiSessionCard[];
  /**
   * Convenience count mirroring `chat.length` — used to tell whether a real
   * conversation has started (e.g. so a refresh doesn't re-show the
   * onboarding form for a session that already has messages but hasn't been
   * moved off the 'onboarding' phase yet) without needing callers to read
   * `chat.length` themselves.
   */
  chatMessageCount: number;
  activeAppVersion: number | null;
  appRefinementRounds: number;
  marketingRefinementRounds: number;
  refinementLimits: RefinementLimits;
  createdAt: string;
  updatedAt: string;
}

export type ApiError = { error: string; [key: string]: unknown };

async function parseJsonOrError<T>(
  res: Response,
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const body = await res.json().catch(() => ({ error: 'invalid_response' }));
  if (!res.ok) {
    return { ok: false, error: body as ApiError };
  }
  return { ok: true, data: body as T };
}

export async function signup(email: string, password: string) {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return parseJsonOrError<AuthUser>(res);
}

export async function signin(email: string, password: string) {
  const res = await fetch('/api/auth/signin', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return parseJsonOrError<AuthUser>(res);
}

/** Signs out the current user — revokes the session server-side and clears the cookie. */
export async function signout() {
  const res = await fetch('/api/auth/signout', { method: 'POST', credentials: 'include' });
  return res.ok;
}

/** The signed-in user's own id/email — used to display who's signed in (account menu). */
export async function getMe() {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  return parseJsonOrError<AuthUser>(res);
}

export async function getLatestSession() {
  const res = await fetch('/api/sessions/latest', { credentials: 'include' });
  return parseJsonOrError<ApiSession | null>(res);
}

/** Every project/session the user has ever started, most recently updated first (project switcher). */
export async function listSessions() {
  const res = await fetch('/api/sessions', { credentials: 'include' });
  return parseJsonOrError<ApiSession[]>(res);
}

export async function createSession() {
  const res = await fetch('/api/sessions', { method: 'POST', credentials: 'include' });
  return parseJsonOrError<ApiSession>(res);
}

/** Fetches one session by id — used to refresh `cards` after a turn emits a card_emitted event. */
export async function getSession(sessionId: string) {
  const res = await fetch(`/api/sessions/${sessionId}`, { credentials: 'include' });
  return parseJsonOrError<ApiSession>(res);
}

export interface BuildSuccessResponse {
  ok: true;
  code: string;
  /** Pre-transpiled plain JS for `code` — AppRenderer runs this directly with no client-side JSX transpilation/eval. */
  compiledCode: string;
  version: number;
  repairRounds: number;
}

export type BuildResponse = BuildSuccessResponse | { ok: false; error: string; reason?: string };

export async function triggerBuild(sessionId: string): Promise<BuildResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/build`, {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}

export interface RefineAppChangeSuccess {
  ok: true;
  kind: 'change_request';
  code: string;
  /** Pre-transpiled plain JS for `code` — AppRenderer runs this directly with no client-side JSX transpilation/eval. */
  compiledCode: string;
  version: number;
  revertedToOriginal: boolean;
  rounds: number;
}

export interface RefineAppClarificationSuccess {
  ok: true;
  kind: 'clarification';
  answer: string;
}

/**
 * A bundled "mega-prompt" request (Epic 5.7) — the caller should show the
 * split-out changes and let the user resend them one at a time; no round
 * was consumed for this response.
 */
export interface RefineAppScopeConfirmationNeeded {
  ok: true;
  kind: 'scope_confirmation_needed';
  detectedChanges: string[];
}

export type RefineAppSuccess =
  | RefineAppChangeSuccess
  | RefineAppClarificationSuccess
  | RefineAppScopeConfirmationNeeded;

export interface RefineAppGateReached {
  ok: false;
  error: 'refinement_limit_reached';
  rounds?: number;
  limit?: number;
}

export interface RefineAppUnsafeRequest {
  ok: false;
  error: 'unsafe_request';
  reason?: string;
}

export interface RefineAppRateLimited {
  ok: false;
  error: 'rate_limited';
  retryAfterMs?: number;
}

export type RefineAppResponse =
  | RefineAppSuccess
  | RefineAppGateReached
  | RefineAppUnsafeRequest
  | RefineAppRateLimited
  | { ok: false; error: string; reason?: string };

/**
 * Applies a targeted change request to the session's active build (#76, with
 * #85/#89's round-classification and intent-parsing in front of it) —
 * distinguishes a real code edit (`change_request`) from a free answered
 * question (`clarification`) so the caller knows whether to expect new code
 * or just a reply.
 */
export function isGateReached(response: RefineAppResponse): response is RefineAppGateReached {
  return !response.ok && response.error === 'refinement_limit_reached';
}

export function isRateLimited(response: RefineAppResponse): response is RefineAppRateLimited {
  return !response.ok && response.error === 'rate_limited';
}

export function isUnsafeRequest(response: RefineAppResponse): response is RefineAppUnsafeRequest {
  return !response.ok && response.error === 'unsafe_request';
}

export interface AppArtifactSuccess {
  ok: true;
  code: string;
  /** Pre-transpiled plain JS for `code` — AppRenderer runs this directly with no client-side JSX transpilation/eval. */
  compiledCode: string;
  version: number;
}

export type AppArtifactResponse = AppArtifactSuccess | { ok: false; error: string };

/**
 * Fetches the session's existing active build (Epic 5.10) — lets a resumed
 * session (page reload after a build/refine happened in an earlier tab
 * session) re-render the app without triggering a brand new build.
 */
export async function getAppArtifact(sessionId: string): Promise<AppArtifactResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/app`, { credentials: 'include' });
  return res.json();
}

export interface AppVersionSummary {
  version: number;
  createdAt: string;
  changeSummary: string;
}

export interface AppVersionsList {
  activeVersion: number | null;
  versions: AppVersionSummary[];
}

/** Lists every app build for the version history / revert UI (Epic 5.6). */
export async function getAppVersions(sessionId: string): Promise<AppVersionsList> {
  const res = await fetch(`/api/sessions/${sessionId}/app/versions`, { credentials: 'include' });
  return res.json();
}

export interface RevertAppVersionSuccess {
  ok: true;
  version: number;
  code: string;
  /** Pre-transpiled plain JS for `code` — AppRenderer runs this directly with no client-side JSX transpilation/eval. */
  compiledCode: string;
}

export type RevertAppVersionResponse = RevertAppVersionSuccess | { ok: false; error: string };

/** One-click revert to an earlier app version (Epic 5.6) — never consumes a refinement round. */
export async function revertAppVersion(
  sessionId: string,
  version: number,
): Promise<RevertAppVersionResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/app/versions/${version}/revert`, {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}

export async function refineApp(
  sessionId: string,
  changeRequest: string,
): Promise<RefineAppResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/refine-app`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changeRequest }),
  });
  return res.json();
}

export interface SendMessageSuccess {
  ok: true;
  reply: string;
  events: TurnEvent[];
}

export type SendMessageResponse =
  | SendMessageSuccess
  | { ok: false; error: string; reason?: string };

/**
 * Sends one chat turn (Epic 2's agent orchestrator, #34) and returns the
 * agent's reply plus the ordered phase/card events from that turn (#39) —
 * the real counterpart to App.tsx's previous handleSend/handleTurnEvents([])
 * placeholder.
 */
export async function sendMessage(sessionId: string, text: string): Promise<SendMessageResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return res.json();
}

export type SelectBuildOptionResponse =
  | { ok: true; card: ApiSessionCard }
  | { ok: false; error: string };

/**
 * Locks in a build option directly from the canvas card (Epic 3.1) — the
 * same effect as asking the agent to do it in chat (select_build_option
 * tool, render-build-options-tool.ts), just without a round-trip through
 * the model.
 */
export async function selectBuildOption(
  sessionId: string,
  index: number,
): Promise<SelectBuildOptionResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/cards/options/select`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index }),
  });
  return res.json();
}

export type LockArchitectureResponse =
  | { ok: true; card: ApiSessionCard }
  | { ok: false; error: string };

/** Locks in the architecture card directly from the canvas (Epic 3.2). */
export async function lockArchitecture(sessionId: string): Promise<LockArchitectureResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/cards/architecture/lock`, {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}

export type LockCostTableResponse =
  | { ok: true; card: ApiSessionCard }
  | { ok: false; error: string };

/** Locks in the cost table card directly from the canvas (Epic 3.4). */
export async function lockCostTable(sessionId: string): Promise<LockCostTableResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/cards/cost/lock`, {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}

export type SelectMarketingPlanResponse =
  | { ok: true; card: ApiSessionCard }
  | { ok: false; error: string };

/** Locks in a marketing plan directly from the canvas card (Epic 3.5). */
export async function selectMarketingPlan(
  sessionId: string,
  index: number,
): Promise<SelectMarketingPlanResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/cards/marketing/select`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index }),
  });
  return res.json();
}

export interface GateStatus {
  next: Phase | null;
  passed: boolean;
  missing: string[];
}

/** Reads whether the session's next phase transition is gated, and by what (Epic 2.2/#50's confirm-build gate). */
export async function getGateStatus(sessionId: string): Promise<GateStatus> {
  const res = await fetch(`/api/sessions/${sessionId}/gate`, { credentials: 'include' });
  return res.json();
}

export type ConfirmBuildResponse =
  | { ok: true; session: ApiSession }
  | { ok: false; error: string; missing?: string[] };

/**
 * Confirms the plan and transitions the session into the build phase
 * (Epic 3.7) — the existing PATCH /api/sessions/:id route already enforces
 * the same gate (phase-gates.ts) server-side and freezes the manifest
 * (manifest-freeze.ts) on a successful transition into 'build'.
 */
export async function confirmBuild(sessionId: string): Promise<ConfirmBuildResponse> {
  const res = await fetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'build' }),
  });
  const body = await res.json();
  if (!res.ok) {
    return { ok: false, error: body.error, missing: body.missing };
  }
  return { ok: true, session: body };
}

export type TierId = 'app-refinement-topup' | 'spec-pack' | 'pitch-deck' | 'financial-pack';

export type CreateCheckoutSessionResponse =
  | { ok: true; sessionId: string; url: string }
  | { ok: false; error: string; details?: string };

/**
 * Starts a Stripe checkout session for the given tier (Epic 6.5's "gate/offer
 * -> checkout"). `successUrl`/`cancelUrl` should both point back into the
 * app so the whole purchase happens inside the funnel rather than handing
 * the user off somewhere they have to navigate back from manually.
 */
export async function createCheckoutSession(
  tierId: TierId,
  successUrl: string,
  cancelUrl: string,
  surface?: string,
): Promise<CreateCheckoutSessionResponse> {
  const res = await fetch('/api/checkout', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tierId, successUrl, cancelUrl, surface }),
  });
  return res.json();
}

/**
 * What the signed-in user currently owns (Epic 6.5's "unlock applies
 * without refresh") — the checkout-return page re-fetches this rather than
 * trusting any client-side "purchase succeeded" assumption, since the real
 * grant only lands once Stripe's webhook (#99) reaches the entitlements
 * service (#100).
 */
export async function getEntitlements(): Promise<{ owned: TierId[] }> {
  const res = await fetch('/api/entitlements', { credentials: 'include' });
  return res.json();
}

export type CancelSubscriptionResponse =
  | { ok: true; cancelAtPeriodEnd: boolean; currentPeriodEnd: number; policy: string }
  | { ok: false; error: string; details?: string };

/** Schedules cancel-at-period-end for the user's app-refinement top-up subscription (Epic 6.7). */
export async function cancelSubscription(): Promise<CancelSubscriptionResponse> {
  const res = await fetch('/api/subscription/cancel', { method: 'POST', credentials: 'include' });
  return res.json();
}

/** Records a request to export all of the user's account data (Epic 6.8) — a request path, not an instant download. */
export async function requestDataExport(): Promise<{ ok: boolean }> {
  const res = await fetch('/api/account/export-request', {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}
