# CLAUDE.md

Read this before developing any feature, fixing any bug, or deploying anything in this repo. For workspace layout, DB setup, branching, and commit/PR conventions, see [CONTRIBUTING.md](CONTRIBUTING.md); for the system architecture, see [architecture.md](architecture.md) (keep it updated when structure changes). This file is for the conventions that make work in this repo correct and safe — not a duplicate tour of the codebase.

## Before writing any code

1. Read the relevant existing files first — this repo has strong, consistent conventions (see below); match them rather than introducing a new pattern.
2. Write the failing test first (TDD). Confirm RED before implementing, confirm GREEN after.
3. Check whether your change touches a versioned prompt/contract file (`codegen-contract.ts`, `system-prompt.ts`) — see below.

## The pipeline — run before every push

```
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

This is exactly what CI's `verify` job runs on every PR and every push to `main` (`.github/workflows/ci.yml`) — it must be green before merging, so run it locally first. `turbo.json` gives every task `dependsOn: ["^build"]`, so `shared` builds before `server`/`app` typecheck/test/lint against it — if you change `shared`, rebuild before trusting a typecheck error in `server` or `app`.

When a contract-rule or fixture change breaks other tests' "known good" fixtures (this has happened — see the `missing_error_boundary` rule's 18-test blast radius across 9 files), fix every fixture rather than weakening the new rule, unless there's a reason the rule itself is wrong.

Testing framework is **Vitest**, tests co-located as `*.test.ts` next to their source in `server/src/`. **`app/` has no automated tests at all** — this is a known gap, not something to silently "fix" by inventing test infra unasked. Because of this gap, any UI-affecting change must be manually verified (dev server or the Playwright MCP tools) and that verification narrated in the commit/PR body — this is the substitute for missing frontend coverage, not optional polish.

## Discriminated-result type guards (non-negotiable)

Every `{ ok: true; ... } | { ok: false; ... }` result type gets a named, exported type guard — never inline `!result.ok` narrowing. Use this exact comment:

```ts
/**
 * Explicit type guard rather than relying on inline `!result.ok` narrowing —
 * this pattern has caused a Vercel-only build failure multiple times this
 * project even when local tsc is clean on the same TypeScript version.
 */
export function isXFailure(result: XResult): result is XFailure {
  return result.ok === false;
}
```

This isn't stylistic — Vercel's separate tsc pass has repeatedly failed to narrow inline checks that local tsc narrows fine, and it's caused real broken deploys. ~18 files in `server/src/` already follow this (`build-orchestrator.ts`, `auto-repair-loop.ts`, `generation-pipeline.ts`, `manifest-tools.ts`, etc.) — follow the same shape for any new discriminated result.

## Codegen contract & system prompt (versioned files)

`server/src/codegen-contract.ts` (`buildCodegenPrompt` + `checkContractViolations`) and `server/src/system-prompt.ts` are two halves of one agreement: the prompt tells the model what to produce, the contract checker verifies it did. Any change to either that could affect generated output:

- Bump `CODEGEN_CONTRACT_VERSION` (in `codegen-contract.ts`) or `SYSTEM_PROMPT_VERSION` (in `system-prompt.ts`) — date + incrementing suffix, e.g. `'2026-09-17.8'`.
- A new prompt requirement gets its own sub-prompt module: `server/src/<name>-pattern.ts` exporting one `buildXPattern(...): string` — a pure function returning prose (never runtime code shipped in Forge), composed into `buildCodegenPrompt` via template-literal concatenation. See `nav-pattern.ts`, `ui-states-pattern.ts`, `mock-auth-pattern.ts` for the shape and doc-comment style to match.
- If the requirement is mechanically checkable (e.g. "must have a real error boundary"), add a static rule to `checkContractViolations`'s `RULES` array with a new `ContractViolation` code. If it isn't mechanically checkable (e.g. "copy must be plain-language"), it stays prompt-only guidance — don't fake a check that can't actually fail.

## The sandboxed app renderer — hard constraints, never weaken

`app/src/components/AppRenderer.tsx` renders all AI-generated app code in an isolated iframe. Do not:

- Add `allow-same-origin` to the iframe's `sandbox` attribute. Omitting it is what makes the isolation real — a same-origin sandboxed frame can still reach the parent via the DOM, handing generated code the parent's real cookies/session.
- Reintroduce client-side dynamic-code execution (e.g. Babel Standalone's runtime JSX transpilation) in the generated-app runtime. Generated code is compiled server-side to plain JS (esbuild, IIFE, global `ForgeCompiledApp`) specifically so the iframe never needs to evaluate a string as code at runtime, which a strict `script-src` CSP blocks — and a `srcDoc` iframe unconditionally inherits the parent's CSP with no sandbox-attribute opt-out.
- Let generated code make real network calls. Enforced both by the codegen contract's `forbidden_fetch`/`forbidden_localStorage` rules and by the sandbox itself.

`server/src/generation-validation.ts` is the gate that runs `checkContractViolations` plus a real compile check before any generated code is persisted or shown to a user, producing the `compiledCode` `AppRenderer.tsx` consumes directly. Both files' doc comments cross-reference each other — read both before changing either.

## Known sharp edges

- **Node version is load-bearing**: `.nvmrc` pins `22.12.0` (not 22.11.x) specifically because Node's support for requiring an ESM module from CommonJS landed unflagged only in 22.12.0, and jsdom's dependency chain (`html-encoding-sniffer` → `@exodus/bytes`, pure ESM) needs it. If a jsdom-touching test fails on CI with `ERR_REQUIRE_ESM` but passes locally, check Node version drift first — don't reach for a package-version pin (already tried, doesn't work: every `html-encoding-sniffer` version depends on `@exodus/bytes`).
- **Anthropic streaming**: a `tool_use` content block's `input` is empty at `content_block_start` — the real arguments arrive afterward as `input_json_delta` events on the same index. Never trust `input` off a live streamed block; the resolved, complete content (tool_use input included) comes from the SDK's `stream.finalMessage()`. Getting this wrong once silently discarded every tool call's real arguments across the whole app (`server/src/anthropic-client.ts`) — the API doesn't surface an obvious client-side error when this happens, so this class of bug hides well. If tool calls are mysteriously arriving with empty/wrong input, check this first.
- **Tool-call diagnostics**: `createAgentOrchestrator` takes a `logger` (forwarded to the tool dispatcher) — never let this default silently in a real deployment (`build-app.ts` must pass `app.log`). A tool's own domain-level failure (`{ok: false, error: ...}`, not a thrown exception) only becomes debuggable in production logs because of this; every `invalid_input`/rejection-style branch should also return a `details: string[]` explaining exactly what was wrong, not a bare code — a model (or a caller) can't self-correct from a code alone.
- **Nightly eval, not a PR gate**: `server/src/eval/`'s generation-quality harness (including the headless-render click-through check) needs a live `ANTHROPIC_API_KEY`, which CI's PR-blocking `verify` job doesn't have. It runs on a schedule (`.github/workflows/nightly-eval.yml`) and exits 0 gracefully without the key — don't wire generation-dependent checks into the required PR gate without deliberately deciding to add the secret and accept the cost/latency.

## Deploys

**Database migrations run on every production deploy.** `server/package.json`'s `vercel-build` script (`server/scripts/vercel-build.mjs`) runs `drizzle-kit migrate` before compiling when `VERCEL_ENV=production`, and fails the build if `DATABASE_URL` is missing — a failed migration blocks the deploy and leaves the previous one live. Preview builds only compile. Before this, migrations were applied by hand and 0008/0009 were silently never run in production. So: commit generated migrations (`pnpm --filter @forge/server db:generate`) with the schema change; never edit an already-applied migration.

`forge-app` and `forge-server` are separate Vercel projects, deployed independently on merge to `main`. `app/vercel.json` proxies `/api/:path*` and `/health` to the deployed `forge-server` URL — the two must both be current for the app to work end to end. After merging a server-affecting PR, confirm the new deployment is actually live (`vercel ls`, or poll `gh api repos/<owner>/<repo>/deployments` for the merge commit's sha under `Production – forge-server`, then hit `/health`) before telling anyone a fix has shipped — a merge to `main` does not mean the fix is live yet.
