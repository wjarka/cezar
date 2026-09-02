# Pi Harness Extra Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default Cezar sessions union a per-harness extra-tools list onto `DEFAULT_ALLOWED_TOOLS`, so a default Pi session exposes `Subagent` while an explicit `allowedTools` still replaces the list exactly.

**Architecture:** Keep one Cezar default list. Add a per-runner extras table next to it (Pi: `Subagent`; others empty). Resolve tools in one helper and call it from both `run.ts` injection sites (`execute` and `runContinuation`). Ignore lists are out of scope. Runners stay dumb: they map whatever list they receive.

**Tech Stack:** TypeScript, Vitest.

**Spec:** GitHub issue `wjarka/cezar#8` and the approved design (one Cezar list + per-harness extras; explicit `allowedTools` replaces, no extras).

## Global Constraints

- No new `CEZ_*` env var, config key, or dependency.
- Do not touch `pi --list-models` / `discoverPiModels`.
- An explicit step `allowedTools` (including `[]`) is the whole list — do not append extras.
- Unspecified `allowedTools` → `[...DEFAULT_ALLOWED_TOOLS, ...extrasFor(backend)]`.
- `claude-cli` uses the `claude` extras row.
- Both `allowedTools:` construction sites in `packages/cezar/src/workflows/run.ts` must go through the same helper in the same commit (AGENTS.md: two `ActiveRun` construction sites).
- Codex/OpenCode still ignore `allowedTools`; empty extras there change nothing.
- No comments unless a site already documents the adjacent invariant.

---

## File map

- Create: `packages/cezar/src/workflows/allowed-tools.test.ts` — helper unit tests
- Modify: `packages/cezar/src/workflows/types.ts` — extras table + `allowedToolsForStep`
- Modify: `packages/cezar/src/workflows/run.ts` — both injection sites
- Modify: `packages/cezar/src/workflows/continuation-tools.test.ts` — Pi default-path extra; keep explicit-list tests
- Modify: `packages/cezar/src/core/pi-runner.ts` — map `Subagent` → `subagent`
- Modify: `packages/cezar/src/core/pi-runner.test.ts` — default+Subagent argv; narrowed list unchanged
- Modify: `README.md` — one Pi tool-access sentence

---

### Task 1: Resolve default tools vs extras in one helper

**Files:**
- Modify: `packages/cezar/src/workflows/types.ts`
- Create: `packages/cezar/src/workflows/allowed-tools.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_ALLOWED_TOOLS`; `AgentBackend` / `RunnerId` from `packages/cezar/src/core/agent-runner.ts`
- Produces:
  - `HARNESS_EXTRA_TOOLS: { readonly [K in RunnerId]: readonly string[] }`
  - `allowedToolsForStep(step: { allowedTools?: string[] } | undefined, backend: AgentBackend | undefined): string[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/cezar/src/workflows/allowed-tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import {
  allowedToolsForStep,
  DEFAULT_ALLOWED_TOOLS,
  HARNESS_EXTRA_TOOLS,
} from './types.ts';

describe('allowedToolsForStep', () => {
  it('unions Pi extras onto the default list when the step does not set allowedTools', () => {
    expect(allowedToolsForStep(undefined, 'pi')).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'Subagent',
    ]);
    expect(allowedToolsForStep({ id: 'task' }, 'pi')).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'Subagent',
    ]);
  });

  it('leaves Claude/Codex/OpenCode on the default list only', () => {
    for (const backend of ['claude', 'claude-cli', 'codex', 'opencode'] as const) {
      expect(allowedToolsForStep(undefined, backend)).toEqual(DEFAULT_ALLOWED_TOOLS);
    }
    expect(allowedToolsForStep(undefined, undefined)).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it('returns an explicit allowedTools list unchanged, including empty', () => {
    const narrowed = ['Read', 'Bash'];
    expect(allowedToolsForStep({ allowedTools: narrowed }, 'pi')).toEqual(narrowed);
    expect(allowedToolsForStep({ allowedTools: [] }, 'pi')).toEqual([]);
    expect(allowedToolsForStep({ allowedTools: [...DEFAULT_ALLOWED_TOOLS, 'Subagent'] }, 'claude')).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'Subagent',
    ]);
  });

  it('does not mutate DEFAULT_ALLOWED_TOOLS', () => {
    const before = [...DEFAULT_ALLOWED_TOOLS];
    allowedToolsForStep(undefined, 'pi').push('nope');
    expect(DEFAULT_ALLOWED_TOOLS).toEqual(before);
  });

  it('has an extras row for every selectable runner', () => {
    expect(Object.keys(HARNESS_EXTRA_TOOLS).sort()).toEqual([...RUNNER_IDS].sort());
    expect(HARNESS_EXTRA_TOOLS.pi).toEqual(['Subagent']);
    expect(HARNESS_EXTRA_TOOLS.claude).toEqual([]);
  });
});
```

The `{ id: 'task' }` fixture is illustrative — the helper only reads `allowedTools`, so pass `{ allowedTools: undefined }` or a one-field object. Do not require `id`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- packages/cezar/src/workflows/allowed-tools.test.ts`

Expected: FAIL — `HARNESS_EXTRA_TOOLS` / `allowedToolsForStep` are not exported.

- [ ] **Step 3: Implement the helper**

In `packages/cezar/src/workflows/types.ts`:

1. Change the existing import to also pull types:

```ts
import { RUNNER_IDS, type AgentBackend, type RunnerId } from '../core/agent-runner.ts';
```

2. Directly under `DEFAULT_ALLOWED_TOOLS`, add:

```ts
/** Extra tools unioned onto the default when a step does not set allowedTools. */
export const HARNESS_EXTRA_TOOLS: { readonly [K in RunnerId]: readonly string[] } = {
  claude: [],
  codex: [],
  opencode: [],
  pi: ['Subagent'],
};

export function allowedToolsForStep(
  step: { allowedTools?: string[] } | undefined,
  backend: AgentBackend | undefined,
): string[] {
  if (step?.allowedTools) return [...step.allowedTools];
  const extras = extrasFor(backend);
  return extras.length === 0 ? [...DEFAULT_ALLOWED_TOOLS] : [...DEFAULT_ALLOWED_TOOLS, ...extras];
}

function extrasFor(backend: AgentBackend | undefined): readonly string[] {
  if (backend === undefined || backend === 'claude-cli') return HARNESS_EXTRA_TOOLS.claude;
  return HARNESS_EXTRA_TOOLS[backend];
}
```

`if (step?.allowedTools)` treats `[]` as explicit (arrays are truthy) and must not fall through to extras.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- packages/cezar/src/workflows/allowed-tools.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cezar/src/workflows/types.ts packages/cezar/src/workflows/allowed-tools.test.ts
git commit -m "$(cat <<'EOF'
fix(workflows): resolve default allowed tools per harness

EOF
)"
```

---

### Task 2: Use the helper at both run.ts construction sites

**Files:**
- Modify: `packages/cezar/src/workflows/run.ts:58`, `run.ts:2437`, `run.ts:3022`
- Modify: `packages/cezar/src/workflows/continuation-tools.test.ts`

**Interfaces:**
- Consumes: `allowedToolsForStep(step, backend)` from Task 1
- Produces: `startSession` specs whose `allowedTools` are helper output; no new export

- [ ] **Step 1: Write the failing continuation test**

In `packages/cezar/src/workflows/continuation-tools.test.ts`:

1. Widen `terminalRun` step `backend` to include `'pi'`.
2. Add a workflow with no `allowedTools` and this test (place it next to the legacy-defaults case):

```ts
  it('a default Pi continuation unions Subagent onto DEFAULT_ALLOWED_TOOLS', async () => {
    const def: WorkflowDef = {
      name: 'pi-task',
      source: 'file',
      steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
    };
    const id = terminalRun({
      def,
      steps: [{ id: 'work', sessionId: 'sess-1', backend: 'pi' }],
    });

    expect(manager!.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const spec = await specAt(0);
    expect(spec.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS, 'Subagent']);
    expect(spec.bashAllowlist).toBeUndefined();
    await settled(id);
  });
```

3. Keep the existing explicit-list tests (`TOOLS`, `TAIL_TOOLS`) unchanged — they pin "explicit replaces, no extras".

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm test -- packages/cezar/src/workflows/continuation-tools.test.ts -t "default Pi continuation"`

Expected: FAIL — continuation still passes bare `DEFAULT_ALLOWED_TOOLS`.

Prove it (AGENTS.md): after the test exists, stash `run.ts` if you already edited it, confirm red, then unstash. A green-either-way test is not this test.

- [ ] **Step 3: Wire both sites**

In `packages/cezar/src/workflows/run.ts`:

Replace the types import:

```ts
import {
  allowedToolsForStep,
  chainStepNote,
  DEFAULT_ALLOWED_TOOLS,
  stepKind,
  type WorkflowDef,
  type WorkflowStepDef,
} from './types.ts';
```

If `DEFAULT_ALLOWED_TOOLS` is unused in `run.ts` after the swap, drop it from this import.

Continuation site (`run.ts` around 2437):

```ts
allowedTools: allowedToolsForStep(toolsStep, continueBackend),
```

Execute site (`run.ts` around 3022):

```ts
allowedTools: allowedToolsForStep(step, stepBackend),
```

Do both in this step. Do not leave one site on `?? DEFAULT_ALLOWED_TOOLS`.

- [ ] **Step 4: Run continuation tests**

Run: `npm test -- packages/cezar/src/workflows/continuation-tools.test.ts`

Expected: PASS, including the new Pi default case and every explicit-list case.

- [ ] **Step 5: Commit**

```bash
git add packages/cezar/src/workflows/run.ts packages/cezar/src/workflows/continuation-tools.test.ts
git commit -m "$(cat <<'EOF'
fix(workflows): apply harness extras at both session construction sites

EOF
)"
```

---

### Task 3: Map Subagent on the Pi argv and pin it

**Files:**
- Modify: `packages/cezar/src/core/pi-runner.ts` (`piTools` map)
- Modify: `packages/cezar/src/core/pi-runner.test.ts`
- Modify: `README.md` (Pi tool-access cell)

**Interfaces:**
- Consumes: `spec.allowedTools` already resolved by Task 2
- Produces: `--tools` values including `subagent` when `Subagent` is in the list; `pi --list-models` unchanged

- [ ] **Step 1: Write the failing argv tests**

In `packages/cezar/src/core/pi-runner.test.ts`, inside `describe('pi RPC argv')`, add:

```ts
  it('maps Subagent onto pi --tools so the default extras list is representable', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'Subagent'],
      }),
    ).toEqual(['--mode', 'rpc', '--tools', 'read,edit,write,grep,find,bash,subagent']);
  });

  it('does not inject Subagent when allowedTools is an explicit subset', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        allowedTools: ['Read', 'Bash'],
      }),
    ).toEqual(['--mode', 'rpc', '--tools', 'read,bash']);
  });
```

Keep the existing six-tool test (it still passes `--tools` without `subagent` — that test is argv mapping, not default resolution). Keep the bashAllowlist fail-closed test.

Do not add `--tools` assertions to `packages/cezar/src/core/pi-model-catalog.test.ts`.

- [ ] **Step 2: Run tests to verify the Subagent map test fails (or already passes via toLowerCase)**

Run: `npm test -- packages/cezar/src/core/pi-runner.test.ts`

If the Subagent test already passes because `map[tool] ?? tool.toLowerCase()` lowercases unknown names, still add `Subagent: 'subagent'` to the map so the extra is named next to Read/Bash/… rather than relying on the fallback. Then re-run: PASS.

If it fails, that means mapping dropped the name — fix in Step 3.

- [ ] **Step 3: Name Subagent in the Pi map**

In `piTools` inside `packages/cezar/src/core/pi-runner.ts`, add `Subagent: 'subagent'` to the `map` object.

- [ ] **Step 4: README**

In `README.md` Pi tool-access cell, change the sentence to say default sessions also pass harness extras (`Subagent`) through `--tools`, and an explicit `allowedTools` still restricts.

- [ ] **Step 5: Re-run Pi tests**

Run: `npm test -- packages/cezar/src/core/pi-runner.test.ts packages/cezar/src/core/pi-model-catalog.test.ts`

Expected: PASS. Model discovery still spawns `['--list-models']` only.

- [ ] **Step 6: Commit**

```bash
git add packages/cezar/src/core/pi-runner.ts packages/cezar/src/core/pi-runner.test.ts README.md
git commit -m "$(cat <<'EOF'
fix(pi): map Subagent through the --tools allowlist

EOF
)"
```

---

### Task 4: Validation gate

**Files:** none new

- [ ] **Step 1: Run the repo verification commands in order**

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Expected: all green. If any fail, use `superpowers:systematic-debugging` — do not open a PR on red.

- [ ] **Step 2: No extra commit unless the gate forced a fix**

If a gate failure required a code change, commit that fix with a message that says what broke, then re-run the failing command before continuing.

---

## Self-review

1. **Spec coverage:** default Pi session exposes `Subagent` (Tasks 1–3); explicit `allowedTools` still restricts (Task 1 empty/subset + Task 2 existing continuation tests + Task 3 subset argv); `--list-models` untouched (Task 3). Ignore lists deferred (no task).
2. **Placeholders:** none.
3. **Type consistency:** `allowedToolsForStep(step, backend)` is the only resolver; both `run.ts` sites call it.
