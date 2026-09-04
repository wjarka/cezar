/**
 * Harness parity — the session and lifecycle matrix.
 *
 * `ui-parity.test.ts` asserts the other axis of the same requirement: that every
 * mapper emits every v2 UI capability, so the GUI degrades per-capability rather
 * than per-backend. This file asserts the rest of the contract in
 * `agent-runner.ts` — session lifecycle, provider-failure surfacing,
 * `sendMessage`, ask routing and park declarations — over the same backends.
 *
 * Spec: `.ai/specs/2026-09-04-harness-parity-matrix.md` (#68). Nine fixes
 * (#2, #3, #4, #5, #6, #46, #48, #53, #54) each repaired a failure mode on one
 * backend that no shared contract covered; every criterion here traces to one of
 * those groups, named in its comment.
 *
 * Two tiers. The seam tier drives each real runner class against that backend's
 * own offline mock. The run tier drives a real `RunManager`, because
 * `ask.requested` comes from the RUNNER for codex and opencode and from
 * `workflows/run.ts` for claude and pi — groups 1, 3 and 6 are only uniform
 * above the seam.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { RUNNER_IDS, type AgentEvent, type RunnerId } from './agent-runner.ts';
import { appendTurnText } from '../workflows/run.ts';
import {
  driveRun,
  driveSeam,
  lastIndexWhere,
  textEvents,
  exemptionFor,
  HARNESS_ADAPTERS,
  PARITY_EXEMPTIONS,
  type RunObservation,
  type ScenarioName,
  type SeamObservation,
  waitFor,
} from './harness-parity.testkit.ts';

/** One row of the matrix, named once and applied to every harness. */
interface SeamCriterion {
  /** Stable id the exemption table references. */
  readonly id: string;
  readonly name: string;
  readonly scenario: ScenarioName;
  /** Throws when the backend does not satisfy the criterion. */
  readonly assert: (obs: SeamObservation) => void;
}

const sessionEvents = (v1: readonly AgentEvent[]) =>
  v1.filter((e): e is Extract<AgentEvent, { type: 'session' }> => e.type === 'session');

const SEAM_CRITERIA: readonly SeamCriterion[] = [
  {
    // Group 7 — the baseline AgentSession contract, never asserted uniformly.
    id: 'S1',
    name: 'S1 terminates with exactly one v1 done, and it is the last event',
    scenario: 'baseline',
    assert: ({ v1 }) => {
      expect(v1.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(v1.at(-1)?.type).toBe('done');
    },
  },
  {
    // Group 2 / #4 — the OpenCode five-minute cut. The runner used to end the
    // turn from its transport's own response, so undici's 300s headers timeout
    // killed a healthy long turn and cezar parked the run. `hold` acknowledges
    // the prompt, THEN waits before emitting content and its terminal signal:
    // a runner that still derives turn-end from the ack reports it before the
    // content it is supposed to close over.
    id: 'S2',
    name: 'S2 ends the turn on its own terminal signal, after the last content event',
    scenario: 'hold',
    assert: ({ v1, v2 }) => {
      const lastContent = Math.max(
        lastIndexWhere(v1, (e) => e.type === 'text'),
        lastIndexWhere(v1, (e) => e.type === 'tool-result'),
      );
      expect(lastContent).toBeGreaterThanOrEqual(0);
      expect(v1.findIndex((e) => e.type === 'turn-end')).toBeGreaterThan(lastContent);
      expect(v2.filter((e) => e.type === 'turn.completed')).toHaveLength(1);
    },
  },
  {
    // Groups 5 and 6 / #2, #3 — one row on purpose. The damage was never split
    // text as such: a cezar marker assembled across deltas stopped matching its
    // anchored regex, because `appendTurnText` joins v1 `text` events with a
    // newline. So `CEZ:` + `MONITORING` as two events becomes `CEZ:\nMONITORING`
    // and the run parks as "needs you" instead of monitoring.
    //
    // Each mock streams the strongest split its own wire permits: codex, opencode
    // and pi split INSIDE the marker (deltas, growing snapshots, tokens), which
    // only a coalescer can reassemble; claude's stream-json has no deltas, so it
    // sends the marker as its own whole assistant block — the multi-block reply
    // that has to park correctly all the same.
    id: 'S8',
    name: 'S8 assembles split assistant text so a trailing marker still anchors',
    scenario: 'split-text',
    assert: ({ v1 }) => {
      const texts = textEvents(v1);
      // No single event may carry a TORN marker: that is the #2 defect exactly,
      // and it survives the assembled-text check below when a stray later event
      // happens to end the turn with an intact copy.
      for (const text of texts) {
        if (text.includes('CEZ:')) expect(text).toContain('CEZ:MONITORING');
      }
      const assembled = texts.reduce((acc, text) => appendTurnText(acc, text), '');
      expect(assembled).toContain('parity split text');
      // The exact test `workflows/run.ts` applies to decide a monitoring park.
      expect(assembled.trimEnd()).toMatch(/CEZ:MONITORING$/);
    },
  },
  {
    // Group 1 / #53, #54 — a runtime provider rejection used to look like a
    // clean finish, so the orchestrator parked the run as "Needs You" and the
    // user waited on an agent that was never coming back. The rejection has to
    // reach BOTH streams: v1 `error` is what fails the run, v2 `session.error`
    // is what the cockpit renders.
    id: 'S7',
    name: 'S7 surfaces a provider failure as an error on both streams',
    scenario: 'provider-error',
    assert: ({ v1, v2 }) => {
      const errors = v1.filter(
        (e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error',
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.message.trim() ?? '').not.toBe('');
      // v2 must signal it too, but the CHANNEL is legitimately per-wire:
      // opencode and pi have a session-level error frame, codex reports a
      // failed turn, and claude only has the result envelope's stop reason.
      // What is uniform — and what #53/#54 were — is that v2 never reports the
      // rejection as a clean end of turn.
      expect(
        v2.some(
          (e) =>
            e.type === 'session.error' ||
            (e.type === 'turn.completed' && e.stopReason === 'error'),
        ),
      ).toBe(true);
      expect(v2.some((e) => e.type === 'turn.completed' && e.stopReason === 'end_turn')).toBe(
        false,
      );
    },
  },
  {
    // Group 4 / #5, #600 — a spawned sub-agent runs in its own child session
    // that emits a full lifecycle over the shared connection. Its terminal
    // signal used to end the PARENT turn, so the parent's remaining work was
    // attributed to a turn cezar had already closed.
    id: 'S9',
    name: 'S9 keeps the parent turn open past a child session terminal signal',
    scenario: 'subagent',
    assert: ({ v1 }) => {
      expect(v1.filter((e) => e.type === 'turn-end')).toHaveLength(1);
      const lastText = lastIndexWhere(v1, (e) => e.type === 'text');
      expect(lastText).toBeGreaterThanOrEqual(0);
      // The parent's own trailing text has to land BEFORE its turn-end. Under
      // #600 the child's completion closed the turn first, so it did not.
      expect(v1.findIndex((e) => e.type === 'turn-end')).toBeGreaterThan(lastText);
    },
  },
  {
    // Group 7 — `resumeCommand()` and "open in CLI" need a session id after
    // every run. The two wires differ and both are legitimate: codex, opencode
    // and pi mint their own and echo a v1 `session` event, while claude pins
    // the id cezar supplied (`--session-id`, claude-cli-runner.ts:385) and
    // returns it on the result. What must never happen is neither — that is a
    // run nobody can resume.
    id: 'S3',
    name: 'S3 yields a resumable session id at the seam',
    scenario: 'baseline',
    assert: ({ v1, result }) => {
      const reported = sessionEvents(v1)[0]?.sessionId ?? result.sessionId;
      expect(reported ?? '').not.toBe('');
    },
  },
  {
    // Group 7 — usage telemetry on both streams, not one.
    id: 'S4',
    name: 'S4 reports token usage on both streams',
    scenario: 'baseline',
    assert: ({ v1, v2 }) => {
      expect(v1.some((e) => e.type === 'token-usage' && e.tokensUsed > 0)).toBe(true);
      expect(v2.some((e) => e.type === 'usage.updated')).toBe(true);
    },
  },
  {
    // Group 7 — the pid roots the run's process tree for resource telemetry (#348).
    id: 'S10',
    name: 'S10 exposes the spawned process pid',
    scenario: 'baseline',
    assert: ({ pid }) => {
      expect(typeof pid).toBe('number');
    },
  },
];

/** One row of the run tier. `settled` says when the run has reached the state
 *  the row is about, so a row waits for its own condition rather than a sleep. */
interface RunCriterion {
  readonly id: string;
  readonly name: string;
  readonly scenario: ScenarioName;
  readonly settled: (record: RunObservation['record']) => boolean;
  readonly assert: (obs: RunObservation) => void;
}

const TERMINAL: readonly string[] = ['review', 'done', 'failed', 'cancelled'];

const askEvents = (obs: RunObservation) =>
  obs.events.filter((e) => e.type === 'ask.requested');

const RUN_CRITERIA: readonly RunCriterion[] = [
  {
    // Group 7 — a run whose agent DECLARED completion reaches cezar's review
    // gate, which is a non-attention terminal state (cezar never auto-merges).
    // The scenario has to declare it: a markerless turn-end parks as `waiting`
    // on every backend, and that is correct behaviour, not a defect.
    id: 'R1',
    name: 'R1 takes a declared-complete run to its review gate',
    scenario: 'done',
    settled: (record) => TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(['review', 'done']).toContain(obs.record?.status);
      expect(obs.statuses).not.toContain('waiting');
    },
  },
  {
    // Group 1 / #53, #54 — the row that would have caught both on whichever
    // backend shipped the bug second. `statuses` rather than the final status:
    // the defect was a park, and a run that parked and later failed anyway is
    // still the bug the user saw.
    id: 'R2',
    name: 'R2 fails the run on a provider failure instead of parking it as Needs You',
    scenario: 'provider-error',
    // `waiting` settles too, so the defect fails on the assertion below rather
    // than as an opaque timeout: a parked run is the bug, not a slow one.
    settled: (record) => TERMINAL.includes(record?.status ?? '') || record?.status === 'waiting',
    assert: (obs) => {
      expect(obs.record?.status).toBe('failed');
      expect(obs.statuses).not.toContain('waiting');
    },
  },
  {
    // Group 3 / #6, #473 — an ask has to reach the cockpit as exactly one card
    // and park the run for the user. The two wires differ underneath: codex and
    // opencode have a native question tool their runners map, claude and pi go
    // through the `CEZ:ASK` marker in `workflows/run.ts`. Above the seam that
    // difference must be invisible.
    id: 'R3',
    name: 'R3 parks as waiting and emits exactly one ask card',
    scenario: 'ask',
    settled: (record) => record?.status === 'waiting' || TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(obs.record?.status).toBe('waiting');
      expect(askEvents(obs)).toHaveLength(1);
    },
  },
  {
    // Group 3 — the other half, and the one that hangs a run when it is wrong:
    // a malformed ask must render no card AND still end its turn. A backend
    // that waits forever for an answer to a question nobody can see is the
    // failure this pins; `settled` returning is itself part of the assertion.
    id: 'R4',
    name: 'R4 renders no card for a malformed ask and still ends the turn',
    scenario: 'ask-bad',
    settled: (record) => record?.status === 'waiting' || TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(askEvents(obs)).toEqual([]);
      expect([...TERMINAL, 'waiting']).toContain(obs.record?.status);
    },
  },
  {
    // Group 6 / #48 — a declared park is a non-attention state. The same
    // scenario S8 asserts survives the seam: the cause below, the effect here.
    id: 'R5',
    name: 'R5 parks a declared monitoring turn as running/monitoring, not waiting',
    scenario: 'split-text',
    settled: (record) => record?.activity === 'monitoring' || record?.status === 'waiting',
    assert: (obs) => {
      expect(obs.record?.activity).toBe('monitoring');
      expect(obs.record?.status).toBe('running');
      expect(obs.statuses).not.toContain('waiting');
    },
  },
];

/** Criteria driven through `whileOpen` rather than one settled observation. */
const CONTROL_CRITERIA = [
  { id: 'S5', scenario: 'baseline' },
  { id: 'S6', scenario: 'baseline' },
] as const;

/**
 * Register one cell. An exempt cell still produces a named test that fails the
 * day the backend gains the thing — see `ExemptionKind` for the two ways that
 * is pinned. Never relax an assertion to accommodate an exemption; delete the
 * exemption instead.
 */
function parityRow(
  backend: RunnerId,
  criterion: SeamCriterion,
  observe: () => Promise<SeamObservation>,
): void {
  const exempt = exemptionFor(criterion.id, backend);
  if (!exempt) {
    it(
      `${backend} ${criterion.name}`,
      async () => {
        criterion.assert(await observe());
      },
      45_000,
    );
    return;
  }
  if (exempt.kind === 'scenario-unconstructible') {
    it(`${backend} is exempt from ${criterion.id} — ${exempt.reason}`, () => {
      // The pin: no prompt is declared, so nothing can drive this row here. Add
      // one and this fails, which is the signal to make the row live.
      expect(HARNESS_ADAPTERS[backend].scenarios[criterion.scenario]).toBeUndefined();
    });
    return;
  }
  it(
    `${backend} is exempt from ${criterion.id} — ${exempt.reason}`,
    async () => {
      const obs = await observe();
      expect(() => criterion.assert(obs)).toThrow();
    },
    45_000,
  );
}

describe('harness parity — seam tier', () => {
  for (const backend of RUNNER_IDS) {
    for (const criterion of SEAM_CRITERIA) {
      parityRow(backend, criterion, () => driveSeam(backend, criterion.scenario));
    }
  }
});

describe('harness parity — seam tier, session control', () => {
  for (const backend of RUNNER_IDS) {
    // Group 7 — mid-task follow-ups are the whole reason a session outlives a turn.
    it(
      `${backend} S5 accepts a follow-up message and completes a second turn`,
      async () => {
        const obs = await driveSeam(backend, 'baseline', {
          whileOpen: async (session, { v1 }) => {
            await waitFor(() => v1.some((e) => e.type === 'turn-end'));
            expect(session.open).toBe(true);
            expect(session.sendMessage([{ type: 'text', text: 'now the second turn' }])).toBe(true);
            await waitFor(() => v1.filter((e) => e.type === 'turn-end').length >= 2);
          },
        });
        expect(obs.v1.filter((e) => e.type === 'turn-end').length).toBeGreaterThanOrEqual(2);
      },
      45_000,
    );

    // Group 7 / #703 — a teardown cezar asked for is never an agent failure.
    it(
      `${backend} S6 settles result on interrupt without reporting an agent error`,
      async () => {
        const obs = await driveSeam(backend, 'baseline', {
          whileOpen: async (session, { v1 }) => {
            await waitFor(() => v1.some((e) => e.type === 'text'));
            session.interrupt();
          },
        });
        expect(obs.v1.some((e) => e.type === 'error')).toBe(false);
        expect(obs.v2.some((e) => e.type === 'turn.completed' && e.stopReason === 'error')).toBe(
          false,
        );
      },
      45_000,
    );
  }
});

describe('harness parity — run tier', () => {
  for (const backend of RUNNER_IDS) {
    for (const criterion of RUN_CRITERIA) {
      const exempt = exemptionFor(criterion.id, backend);
      if (exempt?.kind === 'scenario-unconstructible') {
        it(`${backend} is exempt from ${criterion.id} — ${exempt.reason}`, () => {
          expect(HARNESS_ADAPTERS[backend].scenarios[criterion.scenario]).toBeUndefined();
        });
        continue;
      }
      it(
        exempt
          ? `${backend} is exempt from ${criterion.id} — ${exempt.reason}`
          : `${backend} ${criterion.name}`,
        async () => {
          const obs = await driveRun(backend, criterion.scenario, criterion.settled);
          if (exempt) expect(() => criterion.assert(obs)).toThrow();
          else criterion.assert(obs);
        },
        60_000,
      );
    }
  }
});

describe('harness parity — the matrix itself', () => {
  const allIds = [
    ...SEAM_CRITERIA.map((c) => c.id),
    ...CONTROL_CRITERIA.map((c) => c.id),
    ...RUN_CRITERIA.map((c) => c.id),
  ];
  const scenarioOf = (id: string): ScenarioName => {
    const seam = SEAM_CRITERIA.find((c) => c.id === id);
    if (seam) return seam.scenario;
    const control = CONTROL_CRITERIA.find((c) => c.id === id);
    if (control) return control.scenario;
    const runRow = RUN_CRITERIA.find((c) => c.id === id);
    if (runRow) return runRow.scenario;
    throw new Error(`unknown criterion id "${id}"`);
  };

  // AC #6: a new id in RUNNER_IDS fails here until every row is addressed.
  it('every criterion is a live row or a declared exemption for every runner', () => {
    const missing: string[] = [];
    for (const backend of RUNNER_IDS) {
      for (const id of allIds) {
        const declared = HARNESS_ADAPTERS[backend].scenarios[scenarioOf(id)] !== undefined;
        if (!declared && !exemptionFor(id, backend)) missing.push(`${backend}/${id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every runner id has an adapter', () => {
    for (const backend of RUNNER_IDS) {
      expect(HARNESS_ADAPTERS[backend]?.backend).toBe(backend);
    }
  });

  it('no exemption names a criterion or runner that does not exist', () => {
    for (const exemption of PARITY_EXEMPTIONS) {
      expect(allIds).toContain(exemption.criterion);
      expect(RUNNER_IDS as readonly string[]).toContain(exemption.backend);
      expect(exemption.reason.trim()).not.toBe('');
    }
  });

  it('each exemption kind agrees with whether a scenario prompt is declared', () => {
    for (const exemption of PARITY_EXEMPTIONS) {
      const declared =
        HARNESS_ADAPTERS[exemption.backend].scenarios[scenarioOf(exemption.criterion)] !==
        undefined;
      // A contradictory entry is worse than none: `capability-absent` needs the
      // scenario to be drivable so the inversion means something, and
      // `scenario-unconstructible` claims the opposite.
      expect({ criterion: exemption.criterion, backend: exemption.backend, declared }).toEqual({
        criterion: exemption.criterion,
        backend: exemption.backend,
        declared: exemption.kind === 'capability-absent',
      });
    }
  });

  it('uses no skipped or pending cell — an inapplicable one is a declared exemption', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/);
  });
});
