import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

// The scripts under test are the REPO's, not this package's: `.ai/` is agent-pipeline tooling
// that spans every workspace, so it stays at the root.
const repoRoot = resolve(import.meta.dirname, '../../../..');
const fixtures: string[] = [];
const launchedPids = new Set<number>();

afterEach(() => {
  for (const pid of launchedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The down script already stopped the fixture process.
    }
  }
  launchedPids.clear();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function commandPath(command: string): string {
  return execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
}

const hasSetsid = spawnSync('/bin/sh', ['-c', 'command -v setsid'], { stdio: 'ignore' }).status === 0;

function makeFixture(withSetsid: boolean): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'cez-test-env-launcher-'));
  fixtures.push(root);
  mkdirSync(join(root, '.ai/scripts'), { recursive: true });
  mkdirSync(join(root, '.ai/browsers'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-up.sh'), join(root, '.ai/scripts/test-env-up.sh'));
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-down.sh'), join(root, '.ai/scripts/test-env-down.sh'));
  writeFileSync(join(root, '.ai/browsers/agent-browser.md'), '# test provider\n');
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  // The reuse check compares tracked-source mtimes against the second-truncated
  // startedAt (#36): a cold boot that finishes in the same wall-clock second as
  // these files reads them as changed since boot and refuses a reuse the test
  // expects (#31). Backdate them well outside any boot second so the warm run's
  // verdict never depends on how fast the cold boot was.
  const safelyBeforeBoot = new Date(Date.now() - 30_000);
  utimesSync(join(root, 'package.json'), safelyBeforeBoot, safelyBeforeBoot);
  utimesSync(join(root, 'package-lock.json'), safelyBeforeBoot, safelyBeforeBoot);

  const commands = ['cat', 'chmod', 'curl', 'date', 'dirname', 'find', 'grep', 'id', 'kill', 'mkdir', 'mv', 'nohup', 'pwd', 'rm', 'sh', 'sleep', 'tail', 'uname'];
  if (withSetsid) commands.push('setsid');
  for (const command of commands) symlinkSync(commandPath(command), join(root, 'bin', command));
  symlinkSync(process.execPath, join(root, 'bin/node'));

  writeFileSync(
    join(root, 'bin/npm'),
    // Writes the same artifacts the real preparation chain produces, at the same paths —
    // the up script asserts on them by name (BUILD_ARTIFACTS), so this stub has to follow
    // the workspace layout rather than invent its own.
    `#!/bin/sh
set -eu
mkdir -p node_modules/zod packages/cezar/dist packages/cezar/web/dist
printf '{"name":"zod"}' > node_modules/zod/package.json
cat > packages/cezar/dist/index.js <<'EOF'
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url === '/api/health' ? 'application/json' : 'text/html' });
  res.end(req.url === '/api/health' ? '{"ok":true}' : '<!doctype html>');
}).listen(port, '127.0.0.1');
EOF
printf '<!doctype html>' > packages/cezar/web/dist/index.html
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, 'bin/agent-browser'),
    `#!/bin/sh
case "\${1:-}" in
  doctor) printf '{"ok":true}\\n' ;;
  --version) printf 'test-browser 1\\n' ;;
  *) : ;;
esac
`,
    { mode: 0o755 },
  );
  return { root, path: join(root, 'bin') };
}

function descriptor(root: string): { baseUrl: string; app: { pid: number } } {
  return JSON.parse(readFileSync(join(root, '.ai/qa/test-env.json'), 'utf8')) as {
    baseUrl: string;
    app: { pid: number };
  };
}

for (const withSetsid of [true, false]) {
  test(
    `generated launcher survives its caller and stops by descriptor PID (${withSetsid ? 'setsid' : 'nohup fallback'})`,
    { skip: withSetsid && !hasSetsid ? 'setsid is not available on this platform' : false },
    async () => {
      const fixture = makeFixture(withSetsid);
      const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
      const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
      const down = join(fixture.root, '.ai/scripts/test-env-down.sh');
      const callerPidFile = join(fixture.root, 'caller.pid');

      const coldCommand = withSetsid ? commandPath('setsid') : '/bin/sh';
      const coldArgs = withSetsid
        ? ['/bin/sh', '-c', 'echo $$ > "$2"; sh "$1"', 'launcher-parent', up, callerPidFile]
        : ['-c', 'echo $$ > "$2"; sh "$1"', 'launcher-parent', up, callerPidFile];
      const cold = spawnSync(coldCommand, coldArgs, {
        cwd: tmpdir(),
        encoding: 'utf8',
        env,
        timeout: 20_000,
      });
      assert.equal(cold.status, 0, cold.stderr);
      assert.match(cold.stdout, /TEST_ENV_REUSED=0/);

      const first = descriptor(fixture.root);
      launchedPids.add(first.app.pid);
      if (withSetsid) {
        const callerPid = Number(readFileSync(callerPidFile, 'utf8').trim());
        try {
          process.kill(-callerPid, 'SIGTERM');
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      assert.equal(process.kill(first.app.pid, 0), true);
      const health = await fetch(`${first.baseUrl}/api/health`).then((response) => response.json());
      assert.deepEqual(health, { ok: true });

      const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(warm.status, 0, warm.stderr);
      // try_reuse logs the reason it bailed to stderr, but a cold boot still exits 0 —
      // surface it in the assertion message so a REUSED=0 failure names its cause.
      assert.match(warm.stdout, /TEST_ENV_REUSED=1/, `warm boot refused reuse:\n${warm.stderr}`);
      assert.equal(descriptor(fixture.root).app.pid, first.app.pid, `warm boot refused reuse:\n${warm.stderr}`);

      const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /TEST_ENV_STATUS=stopped/);
      assert.throws(() => process.kill(first.app.pid, 0));
      launchedPids.delete(first.app.pid);
    },
  );
}

test('a tracked file inside the boot second refuses reuse and names the file (#31, #36)', () => {
  // Deterministic reproduction of the #31 flake's signature: the freshness check
  // compares tracked-source mtimes against the second-truncated startedAt, so a
  // file dated inside the boot's own second reads as changed since boot. The warm
  // run must then cold-boot AND say why. NOTE to #36: keeping the milliseconds in
  // startedAt turns this plant into a reuse — flip the REUSED assertion with it.
  const fixture = makeFixture(false);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const down = join(fixture.root, '.ai/scripts/test-env-down.sh');

  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /TEST_ENV_REUSED=0/);
  const coldPid = descriptor(fixture.root).app.pid;
  launchedPids.add(coldPid);

  const startedAt = JSON.parse(readFileSync(join(fixture.root, '.ai/qa/test-env.json'), 'utf8')).startedAt as string;
  const insideBootSecond = new Date(Math.floor(Date.parse(startedAt) / 1000) * 1000 + 500);
  utimesSync(join(fixture.root, 'package.json'), insideBootSecond, insideBootSecond);

  const refused = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /TEST_ENV_REUSED=0/);
  assert.match(refused.stderr, /source changed since boot/);
  assert.match(refused.stderr, /package\.json/);
  // The refused reuse tore the cold app down and rebooted: swap the tracked pid.
  launchedPids.delete(coldPid);
  launchedPids.add(descriptor(fixture.root).app.pid);

  // The refused reuse rebooted onto a fresh startedAt the plant predates, so the
  // next warm run reuses again — the bail-out poisons nothing.
  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /TEST_ENV_REUSED=1/, `warm boot refused reuse:\n${warm.stderr}`);

  const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /TEST_ENV_STATUS=stopped/);
  launchedPids.delete(descriptor(fixture.root).app.pid);
});
