import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { KILL_GRACE_MS, OpencodeServerRunner, createNoTimeoutDispatcher } from './opencode-server-runner.ts';

const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/**
 * #858 — the OpenCode half of #844. `opencode serve` installs its own SIGTERM handler, so the
 * teardown watchdog must decide "is it dead?" from a real exit, never from `ChildProcess.killed`,
 * which Node flips the moment a signal is *delivered*. Gating on the flag made the SIGKILL
 * unreachable for exactly the server it exists for: one leaked process per teardown, and — because
 * every teardown path here is followed by `await this.exited` — a session result that never settles.
 */
describe('SIGTERM→SIGKILL escalation for an opencode server that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 5150,
      // Node's semantics: delivery flips `killed` whether or not the child dies.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  /** No wall-clock deadline; the test drives the teardown itself. */
  function startSession(timeoutMs: number) {
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs }).startSession({
      userPrompt: 'do it',
      cwd: process.cwd(),
    });
    // The server never comes up behind a fake child, so the result rejects/settles on its own path.
    void session.result.catch(() => undefined);
    return session;
  }

  it('escalates after end() even once Node flagged the server as killed', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      session.end();
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the wall-clock timeout path', () => {
    withFakeChild((fake) => {
      startSession(20);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once the server really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      session.end();
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('sends one SIGTERM per session however many teardown paths run', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      // `interrupt()` on the deadline and the result promise's `finally` both
      // reach terminate() for the same session; the escalation is armed once.
      session.interrupt();
      session.end();
      session.interrupt();
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('does not signal at all when the server exited before the teardown', () => {
    withFakeChild((fake) => {
      const session = startSession(0);
      fake.exit(0);

      session.end();
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual([]);
    });
  });
});

/**
 * #4 (upstream #897) — the runner used to long-poll `POST /session/:id/message`
 * and synthesize v1 `turn-end` from that response's settlement, so undici's
 * default 300s headers timeout ended any longer turn with `prompt failed:
 * fetch failed` and cezar parked a healthy run. The turn now starts with
 * `POST /session/:id/prompt_async` and ends from the SSE `session.idle` —
 * the same signal the v2 mapper already uses.
 */
describe('turn lifecycle over prompt_async + session.idle', () => {
  /** In-process stand-in for `opencode serve`: just the endpoints the runner
   *  touches, with the test driving the SSE bus frame by frame. */
  async function startMockServer(opts: { promptStatus?: number } = {}) {
    const clients: ServerResponse[] = [];
    const promptPosts: string[] = [];
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.startsWith('/event')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Flush the headers now — the runner awaits the SSE connection before
        // its first prompt, and Node holds headers back until the first write.
        res.flushHeaders();
        clients.push(res);
        return;
      }
      req.on('data', () => undefined);
      req.on('end', () => {
        if (req.method === 'POST' && url === '/session') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'ses_test' }));
          return;
        }
        if (req.method === 'POST' && /^\/session\/ses_test\/(prompt_async|message)$/.test(url)) {
          promptPosts.push(url);
          res.writeHead(opts.promptStatus ?? 200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      promptPosts,
      send(event: unknown): void {
        for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      async close(): Promise<void> {
        // Keep-alive sockets from the runner's fetch pool would otherwise
        // block `server.close` forever.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** Fake `opencode serve` child: prints the mock server's URL like the real
   *  binary, and dies immediately on any teardown signal. */
  function servedChild(url: string): ChildProcessWithoutNullStreams {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4242,
      kill: () => {
        Object.assign(child, { exitCode: 0, killed: true });
        emitter.emit('exit', 0, null);
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    stdout.write(`opencode server listening on ${url}\n`);
    return child;
  }

  async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const count = (events: AgentEvent[], type: string) => events.filter((e) => e.type === type).length;

  interface Harness {
    events: AgentEvent[];
    mock: Awaited<ReturnType<typeof startMockServer>>;
    session: ReturnType<OpencodeServerRunner['startSession']>;
  }

  async function withSession(
    opts: { promptStatus?: number },
    run: (h: Harness) => Promise<void>,
  ): Promise<void> {
    const mock = await startMockServer(opts);
    spawnHook.override = () => servedChild(mock.url);
    const events: AgentEvent[] = [];
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 30_000 }).startSession(
      { userPrompt: 'go', cwd: process.cwd() },
      (e) => events.push(e),
    );
    try {
      await run({ events, mock, session });
    } finally {
      spawnHook.override = null;
      session.end();
      await session.result.catch(() => undefined);
      await mock.close();
    }
  }

  it('posts the prompt to prompt_async and ends the turn on session.idle, not on the POST response', async () => {
    await withSession({}, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      expect(mock.promptPosts[0]).toBe('/session/ses_test/prompt_async');

      // The POST has resolved; the turn must still be open.
      await sleep(60);
      expect(count(events, 'turn-end')).toBe(0);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);
    });
  });

  it('ignores session.idle from another session and ends the turn once on repeats', async () => {
    await withSession({}, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_other' } });
      await sleep(60);
      expect(count(events, 'turn-end')).toBe(0);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') >= 1);
      await sleep(60);
      expect(count(events, 'turn-end')).toBe(1);
    });
  });

  it('surfaces a note and ends the turn exactly once when the prompt POST fails', async () => {
    await withSession({ promptStatus: 500 }, async ({ events, mock }) => {
      await waitFor(() => count(events, 'turn-end') === 1);
      const notes = events.filter(
        (e) => e.type === 'note' && e.message.startsWith('opencode: prompt failed:'),
      );
      expect(notes).toHaveLength(1);

      // A stray idle afterwards must not end the already-ended turn again.
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await sleep(60);
      expect(count(events, 'turn-end')).toBe(1);
    });
  });

  it('drops SSE parts belonging to another session', async () => {
    await withSession({}, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      mock.send({
        type: 'message.updated',
        properties: { info: { id: 'msg_f', sessionID: 'ses_other', role: 'assistant' } },
      });
      mock.send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_f',
            messageID: 'msg_f',
            sessionID: 'ses_other',
            type: 'text',
            text: 'foreign',
            time: { start: 1, end: 2 },
          },
        },
      });
      mock.send({
        type: 'message.updated',
        properties: { info: { id: 'msg_m', sessionID: 'ses_test', role: 'assistant' } },
      });
      mock.send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_m',
            messageID: 'msg_m',
            sessionID: 'ses_test',
            type: 'text',
            text: 'ours',
            time: { start: 1, end: 2 },
          },
        },
      });
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);

      const texts = events.filter((e) => e.type === 'text').map((e) => e.text);
      expect(texts).toContain('ours');
      expect(texts.join('\n')).not.toContain('foreign');
    });
  });
});

/**
 * #4 — the no-timeout dispatcher keeps undici's default 300s headers/body
 * timeouts from cutting the SSE stream (or any long request) mid-turn. undici
 * is loaded through `process.getBuiltinModule`, so a runtime without it must
 * still start the runner — just without the dispatcher.
 */
describe('createNoTimeoutDispatcher', () => {
  it('returns undefined when process.getBuiltinModule is unavailable', () => {
    expect(createNoTimeoutDispatcher(undefined)).toBeUndefined();
  });

  it('returns undefined when loading undici throws', () => {
    expect(
      createNoTimeoutDispatcher(() => {
        throw new Error('no such module');
      }),
    ).toBeUndefined();
  });

  it('returns undefined when the module exposes no Agent', () => {
    expect(createNoTimeoutDispatcher(() => ({}))).toBeUndefined();
  });

  it('builds an Agent with headers and body timeouts disabled', () => {
    class FakeAgent {
      constructor(readonly opts: Record<string, unknown>) {}
    }
    const dispatcher = createNoTimeoutDispatcher((id) => (id === 'undici' ? { Agent: FakeAgent } : undefined));
    expect(dispatcher).toBeInstanceOf(FakeAgent);
    expect((dispatcher as FakeAgent).opts).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
  });
});
