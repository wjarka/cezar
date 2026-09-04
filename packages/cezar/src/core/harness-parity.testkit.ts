/**
 * Shared fixtures for the harness parity matrix (`harness-parity.test.ts`,
 * spec `.ai/specs/2026-09-04-harness-parity-matrix.md`, #68).
 *
 * `ui-parity.test.ts` pins one axis: every mapper emits every v2 UI capability.
 * This kit supports the other one — the session, lifecycle and error-path
 * contract in `agent-runner.ts` — by driving each backend's REAL runner class
 * against that backend's own offline mock binary.
 *
 * Two deliberate choices live here rather than in the suite:
 *  - **scenario NAMES are shared, spellings are not.** Every mock is already
 *    driven by `mock:<scenario>` markers found in the prompt text, and those
 *    markers were written alongside the golden fixtures. The adapter maps a
 *    shared name onto whatever a backend already calls it, so the matrix
 *    renames nothing and churns no passing runner test.
 *  - **the transport is an explicit `CEZ_*_BIN`, never `CEZ_DRY_RUN`.** A row's
 *    transport is then visible in the adapter instead of implied by a global,
 *    and a backend with no dry-run short-circuit is driven the same way as one
 *    that has it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentEvent, AgentRunResult, AgentSession, RunnerId } from './agent-runner.ts';
import { createRunner } from './runner-factory.ts';
import type { UiEvent } from './ui-events.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The shared scenario catalog. A name, not a marker.
 *
 * | Scenario | The mock must |
 * | --- | --- |
 * | `baseline` | one text, one tool call and result, usage, then its terminal turn signal |
 * | `hold` | delay the terminal turn signal after the last content event |
 * | `split-text` | stream the reply in pieces, ending with a trailing `CEZ:MONITORING` |
 * | `provider-error` | a runtime provider rejection in its native error shape |
 * | `ask` | an ask — native where the wire has one, a `CEZ:ASK` marker otherwise |
 * | `ask-bad` | a malformed ask, and then still end the turn |
 * | `subagent` | child work, and a child terminal signal the parent must survive |
 */
export const SCENARIOS = [
  'baseline',
  'hold',
  'split-text',
  'provider-error',
  'ask',
  'ask-bad',
  'subagent',
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface HarnessAdapter {
  readonly backend: RunnerId;
  /** The env var this backend's runner already reads to locate its binary. */
  readonly binEnv: string;
  /** Absolute path to the offline mock binary. */
  readonly mockBin: string;
  /** Scenario name -> the prompt text this backend's mock answers it with. */
  readonly scenarios: Readonly<Partial<Record<ScenarioName, string>>>;
}

/** Resolved from this file, not the cwd, so the paths hold wherever vitest runs. */
const CLAUDE_MOCK = join(HERE, '..', '..', 'scripts', 'mock-claude.mjs');
const PI_MOCK = join(HERE, '..', '..', 'scripts', 'mock-pi-rpc.mjs');
const CODEX_MOCK = join(HERE, '__fixtures__', 'codex', 'mock-codex-app-server.mjs');
const OPENCODE_MOCK = join(HERE, '__fixtures__', 'opencode', 'mock-opencode-serve.mjs');

/** No marker: every mock's default branch answers this with its scripted turn. */
const BASELINE_PROMPT = 'inspect the working tree';

/** The id cezar pins on every session, mirroring `RunManager`. */
export const PINNED_SESSION_ID = '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90';

export const HARNESS_ADAPTERS: Readonly<Record<RunnerId, HarnessAdapter>> = {
  claude: {
    backend: 'claude',
    binEnv: 'CEZ_CLAUDE_BIN',
    mockBin: CLAUDE_MOCK,
    scenarios: {
      baseline: BASELINE_PROMPT,
      hold: 'mock:hold',
      'split-text': 'mock:split-text',
      // Claude's mock has carried an auth-rejection branch since #430.
      'provider-error': 'mock:auth-error',
      ask: 'mock:ask',
      'ask-bad': 'mock:ask-bad',
      subagent: 'mock:subagents',
    },
  },
  codex: {
    backend: 'codex',
    binEnv: 'CEZ_CODEX_BIN',
    mockBin: CODEX_MOCK,
    scenarios: {
      baseline: BASELINE_PROMPT,
      hold: 'mock:hold',
      'split-text': 'mock:split-text',
      // `turn/failed` with an error message IS codex's provider-rejection shape.
      'provider-error': 'mock:turn-failed',
      ask: 'mock:native-codex-ask',
      'ask-bad': 'mock:ask-bad',
      // #600's repro: a child thread's own turn/completed must not end the parent.
      subagent: 'mock:child-turn',
    },
  },
  opencode: {
    backend: 'opencode',
    binEnv: 'CEZ_OPENCODE_BIN',
    mockBin: OPENCODE_MOCK,
    scenarios: {
      baseline: BASELINE_PROMPT,
      hold: 'mock:hold',
      'split-text': 'mock:split-text',
      'provider-error': 'mock:provider-error',
      ask: 'mock:ask',
      'ask-bad': 'mock:ask-bad',
      subagent: 'mock:subagent',
    },
  },
  pi: {
    backend: 'pi',
    binEnv: 'CEZ_PI_BIN',
    mockBin: PI_MOCK,
    scenarios: {
      baseline: BASELINE_PROMPT,
      hold: 'mock:hold',
      'split-text': 'mock:split-text',
      'provider-error': 'mock:provider-error',
      ask: 'mock:ask',
      'ask-bad': 'mock:ask-bad',
      // No `subagent`: see the S9 entry in PARITY_EXEMPTIONS.
    },
  },
};

/** The prompt text that drives one backend's mock into one shared scenario. */
export function promptFor(backend: RunnerId, scenario: ScenarioName): string {
  const prompt = HARNESS_ADAPTERS[backend].scenarios[scenario];
  if (prompt === undefined) {
    throw new Error(`${backend} declares no prompt for scenario "${scenario}"`);
  }
  return prompt;
}

/**
 * Why a cell is exempt, which decides how the matrix pins it. Both kinds fail
 * the day the backend gains the thing, which is what keeps an exemption from
 * going stale — they just cannot be pinned the same way.
 *
 * - `capability-absent` — the scenario IS constructible on this wire, the
 *   backend simply does not produce the criterion's signal. Pinned by an
 *   INVERTED assertion: the criterion must not hold.
 * - `scenario-unconstructible` — the wire cannot even create the situation, so
 *   there is nothing to invert (an unrelated baseline turn would satisfy some
 *   criteria by accident). Pinned by requiring the adapter to declare NO prompt
 *   for that scenario, so the day a mock answers it the exemption fails and the
 *   row has to go live.
 */
export type ExemptionKind = 'capability-absent' | 'scenario-unconstructible';

export interface ParityExemption {
  /** The criterion's stable id — `S9`, `R3`. */
  readonly criterion: string;
  readonly backend: RunnerId;
  readonly kind: ExemptionKind;
  /** Why this backend's WIRE cannot carry it. Never "not implemented yet". */
  readonly reason: string;
}

/**
 * Cells a backend's upstream protocol genuinely cannot carry.
 *
 * An entry here is not a waiver — see `ExemptionKind` for how each is pinned.
 * "Not implemented yet" is never a reason: that is a failing row, and the fix
 * is the runner, not this table.
 */
export const PARITY_EXEMPTIONS: readonly ParityExemption[] = [
  {
    criterion: 'S9',
    backend: 'pi',
    kind: 'scenario-unconstructible',
    reason:
      "pi's RPC has no child session: a `task` tool is a plain tool call on the parent " +
      'session (see `__fixtures__/pi/rpc-lifecycle.expected.json` — the task item carries no ' +
      'parentItemId and no child transcript), so there is no child terminal signal that could ' +
      'end the parent turn.',
  },
];

export function exemptionFor(criterion: string, backend: RunnerId): ParityExemption | undefined {
  return PARITY_EXEMPTIONS.find((e) => e.criterion === criterion && e.backend === backend);
}

/** Poll a condition. Generous on purpose: under a full suite run these share the
 *  machine with hundreds of files, and a tight bound is a flake, not a check. */
export async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** `Array.prototype.findLastIndex` is ES2023; this package's lib is ES2022. */
export function lastIndexWhere<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (match(items[i] as T)) return i;
  }
  return -1;
}

/** Every v1 `text` event of a run, folded the way the orchestrator folds a turn. */
export function textEvents(v1: readonly AgentEvent[]): string[] {
  return v1
    .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text);
}

export interface SeamObservation {
  readonly v1: readonly AgentEvent[];
  readonly v2: readonly UiEvent[];
  readonly result: AgentRunResult;
  /** The spawned backend process pid, as the seam reported it while open. */
  readonly pid: number | undefined;
}

export interface DriveSeamOptions {
  /** Extra work while the session is live — a follow-up message, an interrupt.
   *  When absent, `driveSeam` waits for the first turn-end or error. */
  readonly whileOpen?: (
    session: AgentSession,
    observed: { v1: readonly AgentEvent[]; v2: readonly UiEvent[] },
  ) => Promise<void>;
  readonly timeoutMs?: number;
}

/**
 * Drive one backend's real runner class against its own offline mock and collect
 * both event streams plus the settled result.
 *
 * The bin env var is set and restored around the call the same way
 * `pi-runner.test.ts` and `workflows/run.test.ts` already do it, and
 * `CEZ_DRY_RUN` is cleared so the mock named by the adapter is the only
 * transport in play.
 */
export async function driveSeam(
  backend: RunnerId,
  scenario: ScenarioName,
  opts: DriveSeamOptions = {},
): Promise<SeamObservation> {
  const adapter = HARNESS_ADAPTERS[backend];
  const savedBin = process.env[adapter.binEnv];
  const savedDry = process.env.CEZ_DRY_RUN;
  process.env[adapter.binEnv] = adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  const cwd = mkdtempSync(join(tmpdir(), `cez-parity-${backend}-`));
  const v1: AgentEvent[] = [];
  const v2: UiEvent[] = [];
  let session: AgentSession | undefined;
  try {
    session = createRunner(backend).startSession(
      {
        userPrompt: promptFor(backend, scenario),
        cwd,
        timeoutMs: opts.timeoutMs ?? 30_000,
        // RunManager always pins one (`workflows/run.ts:2909`), and claude
        // resumes off exactly this value, so a row that omitted it would test
        // a shape no real run ever uses.
        sessionId: PINNED_SESSION_ID,
        // The claude mock writes to these when set; empty keeps a row from
        // touching a handoff file it does not own.
        env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '' },
      },
      (event) => v1.push(event),
      { onUiEvent: (event) => v2.push(event) },
    );
    const pid = session.pid;
    if (opts.whileOpen) await opts.whileOpen(session, { v1, v2 });
    else await waitFor(() => v1.some((e) => e.type === 'turn-end' || e.type === 'error'));
    session.end();
    const result = await session.result.catch(
      (): AgentRunResult => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    );
    return { v1, v2, result, pid };
  } finally {
    session?.interrupt();
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv] = savedBin;
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
    rmSync(cwd, { force: true, recursive: true });
  }
}
