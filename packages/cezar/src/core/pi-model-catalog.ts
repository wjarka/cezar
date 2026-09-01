import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface PiModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, args: readonly string[], cwd: string) => ChildProcessWithoutNullStreams;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
/** Grace between the probe's SIGTERM and the SIGKILL that follows it. */
export const KILL_GRACE_MS = 2_000;
const MAX_MODELS = 500;
/** Defensive cap on what we buffer from a misbehaving child (characters of stdout). */
const MAX_OUTPUT_CHARS = 512 * 1_024;

/** SGR/CSI sequences — `pi --list-models` colorizes a TTY. */
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** The host binary, resolved exactly like `PiRunner` and the backend probe. */
export function resolvePiExecutable(bin?: string): string {
  return bin ?? process.env.CEZ_PI_BIN ?? 'pi';
}

/**
 * Discover the models the host's own pi installation offers, by asking it: `pi --list-models`
 * prints a provider/model table, which is the same list pi's own picker routes to.
 *
 * Best-effort by contract — `RunnerModelCatalog` turns any throw here into a cached or
 * `unavailable` answer, and `auto` stays selectable either way. No config is read or written,
 * no session is started; the child is short-lived and bounded by a deadline, a stdout cap and
 * a model cap.
 */
export async function discoverPiModels(options: PiModelDiscoveryOptions): Promise<ModelOption[]> {
  // `PiRunner` swaps in the bundled mock under CEZ_DRY_RUN=1; that mock speaks RPC, not
  // `--list-models`. Without an explicit binary, skip the spawn so a dry-run cockpit never
  // shells out to a real `pi` (AGENTS.md: dry-run keeps working with no real CLI).
  if (options.bin === undefined && process.env.CEZ_PI_BIN === undefined && process.env.CEZ_DRY_RUN === '1') {
    return [];
  }
  const bin = resolvePiExecutable(options.bin);
  const args = ['--list-models'] as const;
  const child = (options.spawn ?? spawnPi)(bin, args, options.cwd);
  const kill = teardown(child);

  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await new Promise<ModelOption[]>((resolve, reject) => {
      let stdout = '';
      let overflowed = false;

      const fail = (message: string) => {
        reject(new Error(message));
        kill();
      };

      timeout = setTimeout(() => fail('Pi model discovery timed out'), timeoutMs);
      timeout.unref?.();

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (overflowed) return;
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_CHARS) {
          overflowed = true;
          fail('Pi model discovery exceeded the output limit');
        }
      });
      child.stderr.resume();

      child.once('error', () => fail('Pi model discovery child failed'));
      child.once('close', (code) => {
        if (overflowed) return;
        if (code !== 0) {
          fail(`Pi model discovery child exited (${code ?? 'unknown'})`);
          return;
        }
        try {
          resolve(parsePiModels(stdout));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    kill();
  }
}

/**
 * Turn `pi --list-models` output into picker options, preserving pi's own order.
 *
 * The listing is a whitespace-aligned table whose first two columns are `provider` and
 * `model`. Anything without that header is treated as a failure: the CLI said something we
 * cannot read, and reporting "unavailable" is more honest than an empty catalog that looks
 * like "you have no models".
 */
export function parsePiModels(stdout: string): ModelOption[] {
  const lines = stdout
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const headerIndex = lines.findIndex((line) => {
    const cols = line.split(/\s+/);
    return cols[0]?.toLowerCase() === 'provider' && cols[1]?.toLowerCase() === 'model';
  });
  if (headerIndex < 0) {
    throw new Error('Pi model discovery returned unrecognized output');
  }

  const models: ModelOption[] = [];
  const ids = new Set<string>();
  for (const line of lines.slice(headerIndex + 1)) {
    const cols = line.split(/\s+/);
    const provider = cols[0];
    const model = cols[1];
    if (!provider || !model) continue;
    const id = `${provider}/${model}`;
    if (ids.has(id)) continue;
    if (models.length >= MAX_MODELS) throw new Error('Pi model discovery exceeded the size limit');
    ids.add(id);
    models.push({ id, label: model, description: `via ${provider}` });
  }
  return models;
}

function spawnPi(
  bin: string,
  args: readonly string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  const child = nodeSpawn(bin, [...args], {
    cwd,
    env: buildChildEnv({ backend: 'pi' }),
  });
  child.stdin.end();
  return child;
}

/**
 * Returns the probe's teardown: SIGTERM now, SIGKILL once the grace window elapses.
 *
 * Both steps gate on the child's *real* termination, never on `child.killed` — Node flips that
 * flag the moment a signal is delivered. Called from both the failure path and the `finally`,
 * so the escalation is armed at most once.
 */
function teardown(child: ChildProcessWithoutNullStreams): () => void {
  const hasExited = trackChildExit(child);
  let signalled = false;
  return () => {
    if (signalled || hasExited()) return;
    signalled = true;
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (hasExited()) return;
      child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    escalation.unref?.();
  };
}
