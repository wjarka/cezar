import { readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StepAborted } from './steps.ts';
import type { InstallContext } from './types.ts';

const OFFICIAL_CLI_PKG = 'cezarion';

const DEFAULT_RECONFIGURE_HINT = `  cez server-install --platform ubuntu-vps --reconfigure autostart`;

/** The npx package cache root for the user the service runs as (this is the
 *  same user that runs `server-deploy`). Honors an `npm_config_cache` override,
 *  else npm's default `~/.npm`. */
function npxCacheDir(): string {
  const base = process.env.npm_config_cache?.trim() || join(homedir(), '.npm');
  return join(base, '_npx');
}

/** True when a launch command launches cezar via npx (the unpinned
 *  `npx --yes cezarion` form) rather than a checkout (`<node> …/dist/index.js`)
 *  or a global bin. */
export function isNpxExecStart(execStart: string): boolean {
  return /\bnpx\b/.test(execStart) && execStart.includes(OFFICIAL_CLI_PKG);
}

/** True when the unit is an npx launch of a package that is NOT ours — in practice a unit
 *  installed by upstream cezar as `npx --yes cezar-cli`, before this clone took its own npm
 *  identity (#23).
 *
 *  Deliberately not treated as ours to refresh: clearing another package's npx cache would make
 *  the next restart fetch THAT package's `latest`, silently moving the box onto upstream's newest
 *  release — the shadowing the rename exists to prevent. But saying nothing is worse, because
 *  `server-deploy` then reports a green restart while the running version is unchanged. So the
 *  caller warns and names the remedy.
 *
 *  A checkout unit (`<node> …/dist/index.js`) is not foreign, including one running out of an
 *  `_npx` directory: `\bnpx\b` needs a non-word character before `npx`, and `_` is a word
 *  character, so `_npx` never matches. A global-bin unit names no `npx` at all and is likewise
 *  excluded — its restart picks up whatever the global bin now points at. */
export function isForeignNpxExecStart(execStart: string): boolean {
  return /\bnpx\b/.test(execStart) && !execStart.includes(OFFICIAL_CLI_PKG);
}

/**
 * The npx trap (#696 / #32): `npx --yes cezarion` caches the resolved package under
 * `~/.npm/_npx/<hash>` and reuses it forever — a service restart re-execs the
 * SAME cached build, so `server-deploy` would never actually update. Before
 * restarting an npx-based unit we delete the cache entries that contain
 * `cezarion`, so the next launch re-resolves `latest`. Surgical: other npx
 * packages' caches are left untouched. A checkout / global-bin unit has no
 * npx cache to clear and is skipped (its restart picks up the new build/global
 * directly).
 *
 * `execStart` is the live launch command: systemd `ExecStart` on ubuntu-vps,
 * launchd `ProgramArguments` joined on macosx-ngrok.
 */
export function refreshNpxCacheForRedeploy(
  ctx: InstallContext,
  execStart: string,
  opts: { reconfigureHint?: string } = {},
): void {
  if (!isNpxExecStart(execStart)) {
    if (isForeignNpxExecStart(execStart)) {
      ctx.ui.warn(
        `This service is launched by npx from a package other than ${OFFICIAL_CLI_PKG} — most likely a unit ` +
          `installed by upstream cezar as \`npx --yes cezar-cli\`. Restarting it re-execs that package's cached ` +
          `build, so this deploy will NOT change the running version, and clearing that cache would move the box ` +
          `onto upstream's latest instead. Rewrite the unit for ${OFFICIAL_CLI_PKG} first:\n` +
          (opts.reconfigureHint ?? DEFAULT_RECONFIGURE_HINT),
      );
    }
    return;
  }
  const dir = npxCacheDir();
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would clear cached ${OFFICIAL_CLI_PKG} builds under ${dir} so npx refetches the latest.`);
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      ctx.ui.info(`No cached ${OFFICIAL_CLI_PKG} npx build found — the restart will fetch the latest published version.`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new StepAborted(`cannot inspect the npx cache at ${dir}: ${message} — the service was not restarted`);
  }

  let cleared = 0;
  for (const entry of entries) {
    const pkgDir = join(dir, entry);
    const packageDir = join(pkgDir, 'node_modules', OFFICIAL_CLI_PKG);
    try {
      statSync(packageDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new StepAborted(`cannot inspect the npx cache entry at ${packageDir}: ${message} — the service was not restarted`);
    }
    try {
      rmSync(pkgDir, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StepAborted(`cannot remove the cached ${OFFICIAL_CLI_PKG} build at ${pkgDir}: ${message} — the service was not restarted`);
    }
    cleared++;
  }
  ctx.ui.info(
    cleared > 0
      ? `Cleared ${cleared} cached ${OFFICIAL_CLI_PKG} npx build(s) — the restart will fetch the latest published version.`
      : `No cached ${OFFICIAL_CLI_PKG} npx build found — the restart will fetch the latest published version.`,
  );
}
