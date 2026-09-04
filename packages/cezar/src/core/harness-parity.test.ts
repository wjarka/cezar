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
  driveSeam,
  lastIndexWhere,
  textEvents,
  exemptionFor,
  HARNESS_ADAPTERS,
  PARITY_EXEMPTIONS,
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

/** Criteria driven through `whileOpen` rather than one settled observation. */
const CONTROL_CRITERIA = [
  { id: 'S5', scenario: 'baseline' },
  { id: 'S6', scenario: 'baseline' },
] as const;

/**
 * Register one cell. An exempt cell still produces a named test, INVERTED: it
 * asserts the capability really is absent, so a backend that later gains it
 * fails its own exemption. Delete the entry then — never relax the assertion.
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

describe('harness parity — the matrix itself', () => {
  const allIds = [...SEAM_CRITERIA.map((c) => c.id), ...CONTROL_CRITERIA.map((c) => c.id)];
  const scenarioOf = (id: string): ScenarioName => {
    const seam = SEAM_CRITERIA.find((c) => c.id === id);
    if (seam) return seam.scenario;
    const control = CONTROL_CRITERIA.find((c) => c.id === id);
    if (control) return control.scenario;
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

  it('uses no skipped or pending cell — an inapplicable one is a declared exemption', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/);
  });
});
