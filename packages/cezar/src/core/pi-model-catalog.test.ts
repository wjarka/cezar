import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { KILL_GRACE_MS, discoverPiModels, parsePiModels } from './pi-model-catalog.ts';

/**
 * A stand-in for the `pi --list-models` child: write its stdout, then close with a code.
 *
 * Mirrors Node's actual signal semantics — `kill()` records the signal and sets `killed = true`
 * on *delivery*, while the child stays alive until something makes it exit.
 */
function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  say(text: string): void;
  close(code: number): void;
  exit(code: number): void;
  signals: NodeJS.Signals[];
  killed(): boolean;
} {
  const process = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  const exit = (code: number) => {
    Object.assign(process, { exitCode: code });
    process.emit('exit', code, null);
  };
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      signals.push(signal);
      Object.assign(process, { killed: true });
      return true;
    },
    pid: 321,
  });
  return {
    child: process as unknown as ChildProcessWithoutNullStreams,
    say: (text: string) => stdout.write(text),
    close(code: number) {
      exit(code);
      stdout.end();
      queueMicrotask(() => process.emit('close', code));
    },
    exit,
    signals,
    killed: () => signals.length > 0,
  };
}

/** Run discovery against a scripted child; `script` drives it once stdout is wired up. */
function discover(
  script: (fake: ReturnType<typeof fakeChild>) => void,
  options: { timeoutMs?: number } = {},
): Promise<Array<{ id: string; label: string; description: string }>> {
  const fake = fakeChild();
  const promise = discoverPiModels({ cwd: '/repo', spawn: () => fake.child, ...options });
  queueMicrotask(() => script(fake));
  return promise;
}

const TABLE = [
  'provider      model                context  max-out  thinking  images',
  'llama-home    qwen3.8-27b-q4_k_m   131.1K   16.4K    yes       no    ',
  'openai-codex  gpt-5.4              272K     128K     yes       yes   ',
  'xai           grok-4.6             500K     500K     yes       yes   ',
].join('\n');

describe('parsePiModels', () => {
  it('skips the header row and returns provider/model ids from the table', () => {
    expect(parsePiModels(TABLE)).toEqual([
      { id: 'llama-home/qwen3.8-27b-q4_k_m', label: 'qwen3.8-27b-q4_k_m', description: 'via llama-home' },
      { id: 'openai-codex/gpt-5.4', label: 'gpt-5.4', description: 'via openai-codex' },
      { id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' },
    ]);
  });

  it('reads a colorized table', () => {
    expect(
      parsePiModels(
        '\u001B[1mprovider\u001B[0m      \u001B[1mmodel\u001B[0m\n\u001B[32mxai\u001B[0m           \u001B[32mgrok-4.6\u001B[0m\n',
      ),
    ).toEqual([{ id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' }]);
  });

  it('drops duplicate rows, keeping the first', () => {
    expect(
      parsePiModels(
        [
          'provider      model',
          'xai           grok-4.6',
          'openai-codex  gpt-5.4',
          'xai           grok-4.6',
        ].join('\n'),
      ),
    ).toEqual([
      { id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' },
      { id: 'openai-codex/gpt-5.4', label: 'gpt-5.4', description: 'via openai-codex' },
    ]);
  });

  it('refuses a listing with no provider/model header', () => {
    expect(() => parsePiModels('No models configured.\n')).toThrow('unrecognized output');
  });

  it('refuses a listing longer than the size cap', () => {
    const rows = Array.from({ length: 501 }, (_, i) => `openai  gpt-${i}`).join('\n');
    expect(() => parsePiModels(`provider  model\n${rows}`)).toThrow('size limit');
  });
});

describe('discoverPiModels', () => {
  it('lists what the host CLI printed', async () => {
    await expect(
      discover((fake) => {
        fake.say(`${TABLE}\n`);
        fake.close(0);
      }),
    ).resolves.toEqual([
      { id: 'llama-home/qwen3.8-27b-q4_k_m', label: 'qwen3.8-27b-q4_k_m', description: 'via llama-home' },
      { id: 'openai-codex/gpt-5.4', label: 'gpt-5.4', description: 'via openai-codex' },
      { id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' },
    ]);
  });

  it('passes the runner binary override through as `pi --list-models`', async () => {
    const fake = fakeChild();
    let spawned: { bin: string; args: readonly string[]; cwd: string } | undefined;
    const promise = discoverPiModels({
      cwd: '/repo',
      bin: '/opt/pi',
      spawn: (bin, args, cwd) => {
        spawned = { bin, args, cwd };
        return fake.child;
      },
    });
    queueMicrotask(() => {
      fake.say(`${TABLE}\n`);
      fake.close(0);
    });
    await promise;
    expect(spawned).toEqual({ bin: '/opt/pi', args: ['--list-models'], cwd: '/repo' });
  });

  it('does not spawn the host CLI under CEZ_DRY_RUN=1', async () => {
    const savedDry = process.env.CEZ_DRY_RUN;
    const savedBin = process.env.CEZ_PI_BIN;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_PI_BIN;
    try {
      const spawn = vi.fn();
      await expect(discoverPiModels({ cwd: '/repo', spawn })).resolves.toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDry;
      if (savedBin === undefined) delete process.env.CEZ_PI_BIN;
      else process.env.CEZ_PI_BIN = savedBin;
    }
  });

  it('fails when the CLI exits non-zero', async () => {
    await expect(
      discover((fake) => {
        fake.close(1);
      }),
    ).rejects.toThrow('exited (1)');
  });

  it('fails and kills the child when discovery outruns its deadline', async () => {
    const fake = fakeChild();
    const promise = discoverPiModels({ cwd: '/repo', timeoutMs: 5, spawn: () => fake.child });
    await expect(promise).rejects.toThrow('timed out');
    expect(fake.killed()).toBe(true);
  });

  it('escalates to SIGKILL when the probe survives the teardown SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild();
      const rejected = expect(
        discoverPiModels({ cwd: '/repo', timeoutMs: 5, spawn: () => fake.child }),
      ).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(5);
      await rejected;

      expect(fake.signals).toEqual(['SIGTERM']);
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when the child floods stdout', async () => {
    await expect(
      discover((fake) => {
        fake.say(`${'xai  grok-4.6\n'.repeat(60_000)}`);
      }),
    ).rejects.toThrow('output limit');
  });
});
