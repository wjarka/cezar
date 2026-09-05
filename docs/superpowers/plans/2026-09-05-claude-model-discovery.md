# Claude Model Discovery Implementation Plan

> **For agentic workers:** Execute inline with superpowers:executing-plans, using test-driven-development for each task.

**Goal:** Discover host Claude models without regressing the fork's other backends.

**Architecture:** Add a stream-json control-only adapter to RunnerModelCatalog and its existing contract runner list. Reuse shared picker hooks, caching, authentication invalidation and effort selection. Fall back to Claude tier aliases; retain explicit custom and legacy pins.

**Tech Stack:** TypeScript, Zod, Hono, React, Vitest.

**Spec:** Approved design below; user approval relayed on 2026-09-05 as “Issue 89: Approve design”.

## Approved design and constraints

- Selectively port adapter and wire fixtures from upstream 3669ae28; do not replace fork modules wholesale.
- Probe uses the runner's executable and environment resolution, safe mode and no session persistence. Send only `list_models`, never a user message or paid turn.
- Bound discovery to 15 seconds and 200 usable models. Close stdin on settlement, then TERM/KILL at two-second intervals based on actual child exit, using `trackChildExit`.
- Add Claude to the existing Codex/OpenCode/Pi discovery contract. Retain provider identities, per-model effort metadata, generation-aware authentication invalidation and last-good fallback.
- Live/cached Claude models replace fallback suggestions. Unavailable discovery offers auto/opus/sonnet/haiku. Explicit custom and dated pins remain selectable.
- New task, Continue and both Settings surfaces use shared catalog hooks and accurate loading/cached feedback. Existing controls provide keyboard access and theme support; no artwork is needed.
- Preserve `@wjarka/cezarion`, `alias-cezarion`, version lineage and fork provider guards. No dependency or environment variable changes.
- Keep PR draft; parent owns merge.

## Task 1: Adapter and HTTP integration

Files: create `packages/cezar/src/core/claude-model-catalog.ts` and its test; modify `claude-cli-runner.ts`, `packages/contract/src/workspace.ts`, `packages/cezar/src/server/server.ts`, `models-api.test.ts`.

Interface: `discoverClaudeModels(options: { cwd: string; bin?: string; timeoutMs?: number; spawn?: (bin: string, cwd: string) => ChildProcessWithoutNullStreams }): Promise<ModelOption[]>`.

- [x] Port upstream wire tests first and add real executable coverage asserting safe flags and control-only stdin.
- [x] Add API regression asserting `GET /api/v1/models?runner=claude` answers 200 and cached results, and failing refresh retains last-good models after auth invalidation.
- [x] Run `npm test -- packages/cezar/src/core/claude-model-catalog.test.ts packages/cezar/src/server/models-api.test.ts`; record red before adapter exists/route accepts Claude.
- [x] Port adapter with shared child-exit helper; extract existing executable precedence into `resolveClaudeExecutable(bin?: string): string` used by both runner and probe.
- [x] Extend contract enum and register adapter in existing chained route family. Run focused tests green.

## Task 2: Picker integration

Files: `packages/web/src/routes/new-task-form.ts`, its test, query tests, and status callers under new-task, engine-pills, follow-up-engine and Settings; `packages/cezar/src/core/model-presets.ts` and its tests only as needed to retain removed preset guards.

- [x] Add failing assertions: live Claude catalog yields auto plus discovered rows; unavailable yields aliases; explicit dated/custom IDs survive; stale status names Claude; provider-spanning picks and effort levels remain unchanged.
- [x] Implement `modelsForRunner` base as auto when a matching catalog contains models, otherwise existing fallback aliases. Remove dated suggestions while preserving known mismatch guards.
- [x] Extend shared status helper with pending state and forward query fetching state from each picker surface.
- [x] Update query tests to assert Claude discovery fetch and runner-specific keys; run picker/query/surface tests green.

## Task 3: Verification and draft PR

- [x] Document host-local discovery and fallback in README without stale claims about Pi.
- [x] Run required commands in order: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`. Diagnose failures with systematic-debugging; no PR on red.
- [x] Check keyboard, light/dark and 360px UI using existing smoke setup; record actual observations.
- [ ] Review diff for fork guarantees and contract parity, commit Conventional Commit, push, open draft PR closing #89 using repository template and mandatory dev-flow fields.
- [ ] Move board to In review, invoke pr-checks and monitor CI/review to verdict; address actionable feedback and keep draft.

## Verification evidence — 2026-09-05

- API/picker regressions failed before implementation (Claude HTTP 400; fixed suggestions instead of host rows). Loading-status regression failed before plumbing. Dry-run discovery failed with timeout before the mock handled control requests.
- Final full verification: typecheck passed; Vitest 338 files / 6,587 tests passed; node unit gates 37 + 60 tests passed; build and check:pack passed (493 files, 84 cockpit files); package tests 21 passed.
- Independent review found no blocking defects. Corrected its stale route comment and added successful-response TERM/KILL coverage.
- Browser QA with agent-browser and the real dev cockpit: New task at 360×640, light and dark, no horizontal overflow; discovered aliases visible; keyboard selected sonnet and returned focus to Model. Global Settings at 1280×800 showed Claude's discovered rows alongside Codex/OpenCode/Pi catalogs. No new artwork or motion. Existing compact control sizing is retained.
- Continue and Settings selection retention, provider guards, effort handling and auth invalidation are covered by the full component/API suites. Supported host wire behavior uses a real executable fixture; unsupported/malformed/timeout behavior uses scripted child streams, with no paid model turns.
- No SDLC process behavior changed; no process-documentation update is needed.
