# Model-Specific Effort Levels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover ordered per-model effort levels for Pi and OpenCode, preserve them in `/api/v1/models`, and constrain every cockpit effort picker to the selected model without ever submitting a stale unsupported value.

**Architecture:** Add optional canonical `effortLevels` metadata to each existing model option so it travels through the current cache and API. Pi enriches its existing bounded `--list-models` result through one bounded RPC child; OpenCode parses `models --verbose` variant metadata. Shared pure cockpit resolvers produce `auto` plus model-specific choices or the full backward-compatible fallback, and every picker uses the same resolved value for display and submission.

**Tech Stack:** strict TypeScript, Node child processes, Pi JSON-lines RPC, OpenCode verbose JSON, Zod, React 19, TanStack Query, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-03-model-specific-effort-levels-design.md`

## Global Constraints

- Canonical discovered levels are exactly `low`, `medium`, `high`, `xhigh`, `max`, in backend-provided order.
- `auto` is always first in the cockpit, represented as `''`, and omitted from create requests; Continue may explicitly send `''` only to clear an incompatible stored pin.
- Missing, empty, malformed, or wholly unrecognized metadata falls back per model to all five canonical levels.
- A partially recognized metadata set preserves recognized values and drops unknown values.
- Metadata failure for one model never removes another model or its metadata.
- Backends and model entries without `effortLevels` preserve the current full-list behavior.
- Keep the existing 10-second discovery deadline, 512 KiB output cap per child, 500-model cap, SIGTERM/SIGKILL teardown, and dry-run no-real-Pi guarantee.
- Add no dependency, route, environment variable, config key, migration, or persistent state.
- Preserve `modelsLocked`: controls remain read-only and requests omit model/effort overrides.
- Use TDD: write each behavior test first and observe the expected failure before production edits.

---

## File map

- Modify: `packages/contract/src/workspace.ts` — optional canonical metadata in the public model option.
- Create: `packages/contract/src/workspace.test.ts` — runtime schema preservation and rejection coverage.
- Modify: `packages/cezar/src/core/runner-model-catalog.ts` — metadata type carried by cache entries.
- Modify: `packages/cezar/src/core/runner-model-catalog.test.ts` — fresh/stale cache retention.
- Modify: `packages/cezar/src/server/models-api.test.ts` — wire serialization coverage.
- Modify: `packages/cezar/src/core/opencode-model-catalog.ts` — verbose model/variant discovery.
- Modify: `packages/cezar/src/core/opencode-model-catalog.test.ts` — verbose parsing, fallback inputs, bounds.
- Modify: `packages/cezar/src/core/pi-model-catalog.ts` — bounded RPC enrichment.
- Modify: `packages/cezar/src/core/pi-model-catalog.test.ts` — wire-faithful RPC and isolation coverage.
- Modify: `packages/web/src/routes/new-task-form.ts` — shared effort option/value resolvers.
- Modify: `packages/web/src/routes/new-task-form.test.ts` — pure filtering and fallback coverage.
- Modify: `packages/web/src/routes/new-task.tsx` — `/new` picker filtering and safe create body.
- Modify: `packages/web/src/components/engine-pills.tsx` — shared Inbox/GitHub picker filtering and safe body.
- Modify: `packages/web/src/routes/task-thread/follow-up-engine.tsx` — Continue filtering and explicit stale-pin clearing.
- Modify: `packages/web/src/routes/new-task.test.tsx` — composer interaction/submission coverage.
- Modify: `packages/web/src/routes/inbox.test.tsx` — shared `EnginePills` behavior coverage.
- Modify: `packages/web/src/routes/task-thread/follow-up-engine.test.tsx` — Continue options and clear-on-model-change coverage.

---

### Task 1: Extend the contract and prove cache/API preservation

**Files:**
- Modify: `packages/contract/src/workspace.ts`
- Create: `packages/contract/src/workspace.test.ts`
- Modify: `packages/cezar/src/core/runner-model-catalog.ts`
- Modify: `packages/cezar/src/core/runner-model-catalog.test.ts`
- Modify: `packages/cezar/src/server/models-api.test.ts`

**Interfaces:**
- Consumes: `effortLevelSchema` and `EffortLevel` from `packages/contract/src/effort.ts`.
- Produces: `RunnerModelOption.effortLevels?: EffortLevel[]` and matching `ModelOption.effortLevels?: EffortLevel[]`.

- [ ] **Step 1: Write the failing contract test**

Create `packages/contract/src/workspace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runnerModelOptionSchema } from './workspace.ts';

describe('runnerModelOptionSchema effort metadata (#55)', () => {
  it('preserves ordered canonical effort levels and keeps omission compatible', () => {
    expect(runnerModelOptionSchema.parse({
      id: 'openai/gpt-5.6-sol',
      label: 'openai/gpt-5.6-sol',
      description: 'via openai',
      effortLevels: ['low', 'high', 'max'],
    })).toEqual({
      id: 'openai/gpt-5.6-sol',
      label: 'openai/gpt-5.6-sol',
      description: 'via openai',
      effortLevels: ['low', 'high', 'max'],
    });
    expect(runnerModelOptionSchema.parse({ id: 'legacy', label: 'Legacy', description: '' }))
      .toEqual({ id: 'legacy', label: 'Legacy', description: '' });
  });

  it('rejects non-canonical discovered levels', () => {
    expect(runnerModelOptionSchema.safeParse({
      id: 'model', label: 'Model', description: '', effortLevels: ['minimal'],
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npm test -- packages/contract/src/workspace.test.ts`

Expected: FAIL because Zod strips the unknown `effortLevels` key from the parsed result.

- [ ] **Step 3: Add the contract and internal type**

In `packages/contract/src/workspace.ts`, import `effortLevelSchema` and add the optional field:

```ts
import { effortLevelSchema } from './effort.ts';

export const runnerModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  effortLevels: z.array(effortLevelSchema).optional(),
});
```

In `packages/cezar/src/core/runner-model-catalog.ts`:

```ts
import type { EffortLevel } from '@open-mercato/cezar-contract';

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  effortLevels?: EffortLevel[];
}
```

- [ ] **Step 4: Add failing cache and API tests**

Extend the shared `models` fixture in `runner-model-catalog.test.ts` with `effortLevels: ['low', 'high']`, then assert the same literal survives the first live result, the fresh cached result, and the stale last-known-good result.

In `models-api.test.ts`, make the Pi discovery fixture return:

```ts
{
  id: 'xai/grok-4.6',
  label: 'grok-4.6',
  description: 'via xai',
  effortLevels: ['low', 'medium', 'high', 'xhigh'],
}
```

Assert the response model contains the same ordered array. These tests catch metadata being reconstructed or dropped between adapter, cache, and route.

- [ ] **Step 5: Run focused contract/cache/API tests**

Run:

```bash
npm test -- packages/contract/src/workspace.test.ts packages/cezar/src/core/runner-model-catalog.test.ts packages/cezar/src/server/models-api.test.ts packages/cezar/src/server/contract-parity.workspace.test.ts
```

Expected: PASS. Contract parity compiles the exact route response against the changed schema.

- [ ] **Step 6: Commit**

```bash
git add packages/contract/src/workspace.ts packages/contract/src/workspace.test.ts \
  packages/cezar/src/core/runner-model-catalog.ts \
  packages/cezar/src/core/runner-model-catalog.test.ts \
  packages/cezar/src/server/models-api.test.ts
git commit -m "feat(models): carry effort levels in model catalog"
```

---

### Task 2: Parse OpenCode verbose variants per model

**Files:**
- Modify: `packages/cezar/src/core/opencode-model-catalog.ts`
- Modify: `packages/cezar/src/core/opencode-model-catalog.test.ts`

**Interfaces:**
- Consumes: `EffortLevel` and `effortLevelSchema` from the contract.
- Produces: `parseOpencodeModels(stdout): ModelOption[]` where each valid model may carry ordered `effortLevels`.

- [ ] **Step 1: Replace the simple fixture with wire-faithful verbose output tests**

Add a fixture shaped like real `opencode models --verbose` output:

```ts
const VERBOSE_LISTING = [
  'openai/gpt-5.6-sol',
  JSON.stringify({
    id: 'gpt-5.6-sol',
    providerID: 'openai',
    variants: {
      none: { reasoningEffort: 'none' },
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
      xhigh: { reasoningEffort: 'xhigh' },
      max: { reasoningEffort: 'max' },
      turbo: { reasoningEffort: 'turbo' },
    },
  }, null, 2),
  'zai-coding-plan/glm-5.3',
  JSON.stringify({
    id: 'glm-5.3',
    providerID: 'zai-coding-plan',
    variants: { low: {}, high: {}, max: {} },
  }, null, 2),
].join('\n');
```

Assert literal options preserve model and recognized variant order:

```ts
expect(parseOpencodeModels(VERBOSE_LISTING)).toEqual([
  {
    id: 'openai/gpt-5.6-sol',
    label: 'openai/gpt-5.6-sol',
    description: 'via openai',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'zai-coding-plan/glm-5.3',
    label: 'zai-coding-plan/glm-5.3',
    description: 'via zai-coding-plan',
    effortLevels: ['low', 'high', 'max'],
  },
]);
```

Add separate cases proving:

- empty `{ variants: {} }`, missing variants, and only unknown variants omit `effortLevels`;
- a partially recognized map keeps only the recognized subset;
- malformed JSON after one model omits only that model's metadata and does not swallow the next model;
- duplicate IDs keep the first complete entry;
- ANSI stripping, namespaced provider IDs, model cap, timeout, output cap, and teardown still hold.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `npm test -- packages/cezar/src/core/opencode-model-catalog.test.ts`

Expected: FAIL because the current parser treats pretty JSON lines as noise and returns no effort metadata; the argv assertion still expects `['models']`.

- [ ] **Step 3: Implement segmented verbose parsing**

Change discovery argv to:

```ts
const args = ['models', '--verbose'] as const;
```

Parse output as model segments: after ANSI removal, each line matching `MODEL_LINE_RE` starts a model; lines until the next model ID belong to that model's metadata. Parse the joined metadata with `JSON.parse` inside a per-model `try/catch`.

Add focused helpers:

```ts
function effortLevelsFromVariants(metadata: unknown): EffortLevel[] | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.variants)) return undefined;
  const levels: EffortLevel[] = [];
  for (const name of Object.keys(metadata.variants)) {
    const parsed = effortLevelSchema.safeParse(name);
    if (parsed.success && !levels.includes(parsed.data)) levels.push(parsed.data);
  }
  return levels.length > 0 ? levels : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

Build each option with a conditional spread so omission stays omission:

```ts
const effortLevels = effortLevelsFromVariants(metadata);
models.push({
  id,
  label: id,
  description: `via ${provider}`,
  ...(effortLevels ? { effortLevels } : {}),
});
```

If no model ID appears in non-empty output, retain the existing unrecognized-output error. Enforce the cap on unique model IDs, not JSON lines.

- [ ] **Step 4: Run OpenCode tests and verify GREEN**

Run: `npm test -- packages/cezar/src/core/opencode-model-catalog.test.ts packages/cezar/src/server/models-api.test.ts`

Expected: PASS with `['models', '--verbose']` and all existing process bounds intact.

- [ ] **Step 5: Commit**

```bash
git add packages/cezar/src/core/opencode-model-catalog.ts \
  packages/cezar/src/core/opencode-model-catalog.test.ts
git commit -m "feat(opencode): discover model effort variants"
```

---

### Task 3: Enrich Pi models through one RPC child

**Files:**
- Modify: `packages/cezar/src/core/pi-model-catalog.ts`
- Modify: `packages/cezar/src/core/pi-model-catalog.test.ts`

**Interfaces:**
- Consumes: base `ModelOption[]` from `parsePiModels`, JSON-lines Pi RPC commands and responses, `EffortLevel`/`effortLevelSchema`.
- Produces: the same ordered model list with optional model-local `effortLevels`.

- [ ] **Step 1: Extend the fake child harness for two ordered spawns**

Make the test `spawn` return a base-list child first and an RPC child second. Capture argv and stdin. The RPC fixture must mirror Pi's real response shape:

```json
{"id":"set:0","type":"response","command":"set_model","success":true,"data":{"provider":"openai-codex","id":"gpt-5.4"}}
{"id":"levels:0","type":"response","command":"get_available_thinking_levels","success":true,"data":{"levels":["low","medium","high","xhigh"]}}
```

Use a second model whose levels are `['off', 'minimal', 'low', 'high', 'max', 'future']` and assert only `['low', 'high', 'max']` survives.

- [ ] **Step 2: Add failing Pi behavior tests**

Cover these observable cases:

1. base list order is unchanged and each successful set/levels pair enriches only its model;
2. generated stdin alternates literal `set_model` and `get_available_thinking_levels` commands with stable `set:N` / `levels:N` IDs;
3. a failed `set:N` causes `levels:N` to be ignored so previous-model levels cannot leak;
4. a missing/malformed/unknown `levels:N` omits only that model's field;
5. an RPC child error, non-zero exit, timeout, or output overflow returns the base model list without metadata;
6. both child argv arrays are correct and the total timeout budget is not reset for enrichment;
7. `CEZ_DRY_RUN=1` with no explicit Pi binary spawns neither child and returns `[]`;
8. existing table parser, 500-model cap, base child failures, and SIGKILL escalation remain green.

- [ ] **Step 3: Run Pi tests and verify RED**

Run: `npm test -- packages/cezar/src/core/pi-model-catalog.test.ts`

Expected: FAIL because discovery currently performs only `pi --list-models` and returns no metadata.

- [ ] **Step 4: Implement bounded best-effort enrichment**

Keep the current base list probe and parser. After it succeeds, calculate remaining time from one deadline and run one RPC child with argv:

```ts
const RPC_ARGS = [
  '--mode', 'rpc',
  '--no-session',
  '--no-tools',
  '--no-skills',
  '--no-prompt-templates',
] as const;
```

Do not pass `--no-extensions`: extension-provided/custom models must remain discoverable.

Write all model command pairs to stdin, then end it:

```ts
models.forEach((model, index) => {
  const slash = model.id.indexOf('/');
  child.stdin.write(`${JSON.stringify({
    id: `set:${index}`,
    type: 'set_model',
    provider: model.id.slice(0, slash),
    modelId: model.id.slice(slash + 1),
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    id: `levels:${index}`,
    type: 'get_available_thinking_levels',
  })}\n`);
});
child.stdin.end();
```

Parse newline-delimited responses into two maps: successful `set:N` IDs and recognized canonical levels for successful `levels:N` responses. Only attach levels when both indexes succeeded, the response array contains at least one recognized canonical level, and duplicates have been removed in response order.

Implement enrichment as best-effort:

```ts
const levels = await discoverPiEffortLevels(/* child options + remaining timeout */)
  .catch(() => new Map<number, EffortLevel[]>());
return models.map((model, index) => {
  const effortLevels = levels.get(index);
  return effortLevels ? { ...model, effortLevels } : model;
});
```

Reuse the existing teardown semantics for the second child. Apply a separate 512 KiB stdout cap to it. If no time remains after the base probe, skip enrichment and return the base list.

- [ ] **Step 5: Run Pi tests and verify GREEN**

Run: `npm test -- packages/cezar/src/core/pi-model-catalog.test.ts packages/cezar/src/core/runner-model-catalog.test.ts`

Expected: PASS; base discovery failures still degrade through `RunnerModelCatalog`, while enrichment failures keep base models.

- [ ] **Step 6: Commit**

```bash
git add packages/cezar/src/core/pi-model-catalog.ts \
  packages/cezar/src/core/pi-model-catalog.test.ts
git commit -m "feat(pi): discover model thinking levels"
```

---

### Task 4: Add one shared cockpit effort resolver

**Files:**
- Modify: `packages/web/src/routes/new-task-form.ts`
- Modify: `packages/web/src/routes/new-task-form.test.ts`

**Interfaces:**
- Produces:
  - `effortOptionsForModel(runner: Runner, model: string, catalog?: RunnerModelCatalogResponse): readonly EffortOption[]`
  - `resolveEffort(effort: string | null | undefined, options: readonly EffortOption[]): string`
- Consumes: existing `EFFORT_OPTIONS`; model catalog metadata.

- [ ] **Step 1: Write failing pure resolver tests**

Import `RunnerModelCatalogResponse` from `@open-mercato/cezar-api-client` and the new helpers in `new-task-form.test.ts`, then add literal cases:

```ts
const catalog: RunnerModelCatalogResponse = {
  runner: 'opencode',
  models: [
    {
      id: 'openai/gpt-5.4', label: 'GPT 5.4', description: '',
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      id: 'zai/glm-5.3', label: 'GLM 5.3', description: '',
      effortLevels: ['low', 'high', 'max'],
    },
  ],
  source: 'live',
  stale: false,
};

expect(effortOptionsForModel('opencode', 'zai/glm-5.3', catalog).map(o => o.value))
  .toEqual(['', 'low', 'high', 'max']);
expect(resolveEffort('medium', effortOptionsForModel('opencode', 'zai/glm-5.3', catalog)))
  .toBe('');
expect(resolveEffort('high', effortOptionsForModel('opencode', 'zai/glm-5.3', catalog)))
  .toBe('high');
```

Also assert full fallback `['', 'low', 'medium', 'high', 'xhigh', 'max']` for Claude, Codex, auto model, custom ID, absent field, empty array, unknown model, missing catalog, and an older unavailable response. Assert one model's metadata never affects another.

- [ ] **Step 2: Run helper tests and verify RED**

Run: `npm test -- packages/web/src/routes/new-task-form.test.ts -t "effort option resolution"`

Expected: FAIL because the helpers are not exported.

- [ ] **Step 3: Implement the helpers**

Give the existing option array a reusable element type:

```ts
export type EffortOption = (typeof EFFORT_OPTIONS)[number];
const FALLBACK_EFFORT_OPTIONS: readonly EffortOption[] = EFFORT_OPTIONS;

export function effortOptionsForModel(
  runner: Runner,
  model: string,
  catalog?: RunnerModelCatalogResponse,
): readonly EffortOption[] {
  const levels = runnerDiscoversModels(runner)
    ? catalog?.models.find((entry) => entry.id === model)?.effortLevels
    : undefined;
  if (!levels?.length) return FALLBACK_EFFORT_OPTIONS;
  const allowed = new Set(levels);
  const filtered = EFFORT_OPTIONS.filter((option) => option.value === '' || allowed.has(option.value));
  return filtered.length > 1 ? filtered : FALLBACK_EFFORT_OPTIONS;
}

export function resolveEffort(
  effort: string | null | undefined,
  options: readonly EffortOption[],
): string {
  const value = effort ?? '';
  return options.some((option) => option.value === value) ? value : '';
}
```

If TypeScript needs narrowing for `option.value === ''`, use a small predicate or filter only `EFFORT_OPTIONS.slice(1)` before prepending `EFFORT_OPTIONS[0]`; do not widen the canonical type to arbitrary strings.

- [ ] **Step 4: Run helper tests and verify GREEN**

Run: `npm test -- packages/web/src/routes/new-task-form.test.ts`

Expected: PASS, including all existing model resolution behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/new-task-form.ts packages/web/src/routes/new-task-form.test.ts
git commit -m "feat(web): resolve effort options per model"
```

---

### Task 5: Wire every picker and clear unsupported submissions

**Files:**
- Modify: `packages/web/src/routes/new-task.tsx`
- Modify: `packages/web/src/components/engine-pills.tsx`
- Modify: `packages/web/src/routes/task-thread/follow-up-engine.tsx`
- Modify: `packages/web/src/routes/new-task.test.tsx`
- Modify: `packages/web/src/routes/inbox.test.tsx`
- Modify: `packages/web/src/routes/task-thread/follow-up-engine.test.tsx`

**Interfaces:**
- Consumes: `effortOptionsForModel` and `resolveEffort` from Task 4.
- Produces: filtered semantic menu rows and create/continue bodies that never carry unsupported effort.

- [ ] **Step 1: Write the failing `/new` interaction test**

Make the test model endpoint return two OpenCode or Pi models with different metadata. Start with the first model, pick an effort valid only there, then switch to the second model. Assert:

- opening `Effort` exposes only `auto` plus the first model's levels;
- after the model switch the effort pill reads `auto`;
- the create request contains the new model and no `effort` key.

Use `getByRole('button', { name: 'Effort' })` and `menuitemradio` rows, not implementation selectors for the option assertions.

- [ ] **Step 2: Write the failing shared `EnginePills` test through Inbox**

In `inbox.test.tsx`, return a discovered model with `effortLevels: ['low', 'high']`. Pick `high`, change to a model that supports `['low']`, start the card, and assert the body contains the selected model but omits effort. Also assert the second model's effort menu is exactly `auto`, `low`.

This covers both Inbox and GitHub because both render the same `EnginePills` implementation and send `engineBody`/`engineRunBody`; keep existing GitHub transport tests as the integration guard.

- [ ] **Step 3: Write failing Continue tests**

Extend `serve()` in `follow-up-engine.test.tsx` to accept per-runner model responses. Add:

1. a run pinned to model A / `effort: 'xhigh'`; switching to model B with only `low/high` displays `auto` and posts `{ model: 'model-b', effort: '' }`, clearing the stored pin;
2. a valid inherited effort remains visible and untouched Continue posts `{}`;
3. an explicit valid new effort posts that value;
4. delayed metadata that invalidates a previously visible value still results in `effort: ''` before submission.

- [ ] **Step 4: Run all three UI test files and verify RED**

Run:

```bash
npm test -- packages/web/src/routes/new-task.test.tsx \
  packages/web/src/routes/inbox.test.tsx \
  packages/web/src/routes/task-thread/follow-up-engine.test.tsx
```

Expected: FAIL because every picker still maps the global `EFFORT_OPTIONS`, and stale effort remains in request bodies.

- [ ] **Step 5: Wire `/new`**

After resolving `model`, derive:

```ts
const effortOptions = effortOptionsForModel(displayRunner, model, catalog.data);
const effort = modelsLocked ? '' : resolveEffort(draft.effort, effortOptions);
```

Render `effortOptions`, not global `EFFORT_OPTIONS`. In the model pick handler, derive the next model's options from the current catalog and clear only an incompatible effort:

```ts
onPick={(nextModel) => {
  const nextOptions = effortOptionsForModel(displayRunner, nextModel, catalog.data);
  update({ model: nextModel, effort: resolveEffort(draft.effort, nextOptions) });
}}
```

The resolved `effort` already feeds both `buildCreateRunBody` and `buildPlannedRunBody`, so asynchronous metadata cannot submit the stale draft value.

- [ ] **Step 6: Wire shared `EnginePills`**

In `useResolvedEngine`, resolve model first, derive effort options from that model/catalog, and return both effective effort and options on `ResolvedEngine`. `engineBody` continues to serialize only the resolved effort.

Render the returned options. On a same-runner model pick, clear an incompatible effort before calling `onChange`. On runner changes keep the raw pick temporarily; after the next runner catalog resolves, `useResolvedEngine` must display and serialize only its resolved value.

- [ ] **Step 7: Wire Continue's clear semantics**

Derive raw and effective values separately:

```ts
const effortOptions = effortOptionsForModel(runner, model, catalog.data);
const rawEffort = modelsLocked ? '' : (pickedEffort ?? run.effort ?? '');
const effort = resolveEffort(rawEffort, effortOptions);
const engineChanged = pickedModel !== null || continuation.runnerOverride !== undefined;
const mustClearStoredEffort =
  !modelsLocked && pickedEffort === null && engineChanged && rawEffort !== '' && effort === '';
```

Serialize:

```ts
effort: !modelsLocked && pickedEffort !== null
  ? effort
  : mustClearStoredEffort
    ? ''
    : undefined,
```

Render `effortOptions`. When the user picks a model, set that model and set picked effort to `''` only when the currently effective effort is unsupported by the new model. This makes the immediate visible reset explicit; `mustClearStoredEffort` remains the asynchronous-data safety net.

- [ ] **Step 8: Run UI tests and verify GREEN**

Run the same three-file command from Step 4, then:

```bash
npm test -- packages/web/src/routes/github/github.test.tsx packages/web/src/api/queries.test.tsx
```

Expected: PASS. Existing untouched body, modelsLocked, account switching, runner fallback, and old catalog tests must stay green.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/routes/new-task.tsx \
  packages/web/src/components/engine-pills.tsx \
  packages/web/src/routes/task-thread/follow-up-engine.tsx \
  packages/web/src/routes/new-task.test.tsx \
  packages/web/src/routes/inbox.test.tsx \
  packages/web/src/routes/task-thread/follow-up-engine.test.tsx
git commit -m "feat(web): filter effort by selected model"
```

---

### Task 6: Verification, regression proof, and experience check

**Files:** none unless verification exposes a defect.

- [ ] **Step 1: Prove the primary regression tests fail without production fixes**

For each task where red was not already captured cleanly, stash only that task's production files, run its new focused test and record the expected failure, then restore:

```bash
git stash push -- <production-files>
npm test -- <new-focused-test>
git stash pop
```

Do not stash test files. At minimum prove one discovery test and one picker model-change submission test fail without their fixes.

- [ ] **Step 2: Run the repository verification commands in required order**

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Expected: all commands exit 0. On any failure, use `superpowers:systematic-debugging`, fix the cause, rerun the focused failing command, then restart the required sequence from the failed gate.

- [ ] **Step 3: Perform the UI craft check**

Run `npm run test:e2e`. If the suite reports `TEST_E2E_STATUS=skipped`, record it as skipped rather than passed. Confirm from the focused semantic UI tests and, when the environment is available, the real cockpit:

- every effort menu keeps `auto`;
- unsupported rows disappear after model selection;
- the compact footer still wraps at approximately 360 px without clipping;
- keyboard and accessible `Effort` labels remain intact;
- light/dark tokens and reduced-motion behavior are unchanged;
- no loading, empty, error, offline, imagery, or motion state was added.

Record actual observations for the PR's **Experience** section; do not claim a viewport/theme check that was not performed.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- packages/contract/src/workspace.ts \
  packages/cezar/src/core/runner-model-catalog.ts \
  packages/cezar/src/core/pi-model-catalog.ts \
  packages/cezar/src/core/opencode-model-catalog.ts \
  packages/web/src/routes/new-task-form.ts \
  packages/web/src/components/engine-pills.tsx \
  packages/web/src/routes/new-task.tsx \
  packages/web/src/routes/task-thread/follow-up-engine.tsx
```

Check for duplicate vocabularies, widened API shapes, unconditional `effortLevels: undefined`, stale effort serialization, dropped discovery limits, and unrelated refactors.

- [ ] **Step 5: Commit any verification-only correction**

Only if verification required a code change:

```bash
git add <corrected-files>
git commit -m "fix(effort): address verification regression"
```

Re-run the affected focused test and every required verification command after the correction.

---

## Plan self-review

1. **Spec coverage:** Task 1 covers contract/cache/API; Tasks 2 and 3 cover both discovery backends and per-model fallback; Task 4 defines one canonical cockpit resolver; Task 5 applies it to `/new`, shared Inbox/GitHub pills, and Continue with reset-before-submit; Task 6 covers full verification and UI craft.
2. **Placeholder scan:** no TBD/TODO, deferred implementation, or unnamed error handling remains.
3. **Type consistency:** every layer uses contract `EffortLevel`; discovery writes `ModelOption.effortLevels`; the API exposes `RunnerModelOption.effortLevels`; the cockpit reads it through `RunnerModelCatalogResponse`; all surfaces call the same `effortOptionsForModel` and `resolveEffort` signatures.
4. **Compatibility:** optional metadata and per-model fallback preserve old servers, old cache entries, static runners, custom IDs, unavailable discovery, `modelsLocked`, and untouched Continue requests.
