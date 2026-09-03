# Publishing — stable releases and npm previews

## Package identity

This repository publishes as **`cezarion`** — chosen for this clone in #23, and
confirmed free on the registry before the first release. Two names reach npm:

| What a user types | Package | Why |
|---|---|---|
| `npx cezarion` | `cezarion` (unscoped alias, `alias-cezarion/`) | the install line every doc quotes |
| `npm i @wjarka/cezarion` | `@wjarka/cezarion` (`packages/cezar`) | the implementation, under a personal scope |

Installed bins are **`cezarion`** and **`cez`**. Upstream's `cezar` and
`cezar-cli` bins are deliberately **not** published here, so a global install of
this clone can never shadow the upstream tool. The product keeps its name inside
the repo — `.ai/cezar/`, `~/.cezar/`, `CEZ_*` and the `cez` command are
unchanged — and the private workspace packages keep their `@open-mercato/*`
names because they never reach npm.

How cezar reaches npm. Two paths, deliberately separate
(spec: `.ai/specs/2026-07-18-npm-preview-publish.md`, issue #482), with
two authentication methods (#33):

- **Stable releases** (`latest`) are **owner-driven and manual**: a maintainer
  runs the [`Release`](../.github/workflows/release.yml) workflow from the
  Actions tab (`workflow_dispatch`) and picks the version bump. CI never moves
  `latest` — a push to `main` publishes nothing. The job authenticates with
  **npm trusted publishing** (OIDC): no `NPM_TOKEN` in the job, provenance
  attached automatically.
- **Previews** are **CI-driven**: the `publish-snapshot` job in
  [`ci.yml`](../.github/workflows/ci.yml) publishes a snapshot of every package
  after a fully green `verify` run — on `develop` pushes and same-repo PRs only.
  Authenticated with `NPM_TOKEN`.
- **Nightlies** are **clock-driven**: [`nightly.yml`](../.github/workflows/nightly.yml)
  cuts `main`'s tip every night under the `nightly` dist-tag, so `npx cezarion@nightly`
  is always the trunk. Also runnable on demand from the Actions tab.
  Authenticated with `NPM_TOKEN`.

| Channel | Workflow | Authentication | Provenance |
|---|---|---|---|
| `latest` (stable) | `release.yml` (`production`) | OIDC trusted publisher — no npm credential in the job | automatic (do not pass `--provenance`) |
| `pr-<N>`, `develop` | `ci.yml` `publish-snapshot` | `NPM_TOKEN` | `--provenance` |
| `nightly` | `nightly.yml` | `NPM_TOKEN` | `--provenance` |
| drop `pr-<N>` dist-tag | `npm-preview-cleanup.yml` | `NPM_TOKEN` (`npm dist-tag rm`; OIDC does not cover this command) | n/a |

npm allows **one trusted publisher per package**. This repository publishes two
packages from three workflows, so only the stable path is OIDC. Collapsing the
three publish jobs into one reusable workflow would not lift that ceiling:
npm validates the *calling* workflow filename (`job_workflow_ref`), not the
called one.

Every workspace manifest is in the release, always at the same version; two of
them ship:

| Package | Ships? | What it is |
|---|---|---|
| `@open-mercato/cezar-contract` | **no — `private`** | the HTTP contract schemas (`packages/contract`) |
| `@open-mercato/cezar-api-client` | **no — `private`** | the typed client (`packages/api-client`) |
| `@wjarka/cezarion` | yes | the service + CLI, ships the built cockpit (`packages/cezar`) |
| `@open-mercato/cezar-web` | **no — `private`** | the cockpit SPA (`packages/web`) |
| `cezarion` | yes | the unscoped bin alias, so `npx cezarion` works (`alias-cezarion`) |

The publishable rows are also the **publish order**, and it is load-bearing: each
package depends on the one above it, so publishing a dependent first would briefly
advertise a version of its dependency that is not on the registry yet. The
workspace root itself is `private` and is not in the release at all.

**Private ≠ excluded.** A private package is stamped like everything else — its
version moves in lockstep and every pin against it is rewritten — it is
simply never handed to npm. Leaving one behind is what made a version-bump
commit fail `npm ci` (#35): consumers demanded `^<new>` while the unstamped
manifest still said `<old>`, so npm fell through to the registry and missed.

The api-client is consumed inside the workspace (the cockpit bundles it from
source, the service's tests import it) and stays unpublished until its surface
stops moving: it still carries the hand-written DTOs, which shrink family by
family as routes are converted, so publishing now would advertise a contract
that changes materially every release. Publishing a private package is one
line — delete `"private": true` from its manifest; the release code reads npm's
own flag and needs no change. A newly public name still needs a first token
publish (trusted publishers are configured on an existing package) and then
its own trusted-publisher row plus a token grant — see the admin setup below.

## Stable releases

Run **Actions → Release → Run workflow** from `main` and choose a bump:

| Bump | Effect (base `0.1.5`) |
|---|---|
| `patch` | `0.1.6` |
| `minor` | `0.2.0` |
| `major` | `1.0.0` |
| `existing` | publishes the version already committed to `packages/cezar/package.json` |

The workflow verifies, builds, then `scripts/release.mjs` stamps every manifest
(intra-release dependencies keep a **caret** range — stable follows compatible
releases, unlike the exact-pinned snapshots), publishes them in dependency order
with `--tag latest` (no `--provenance` — trusted publishing attaches it), commits
the bump, tags `v<version>`, and cuts a GitHub Release. It's gated behind the
`production` environment, so a release can require reviewer approval — and the
trusted publisher on npmjs.com is pinned to that same environment name. Outside
Actions, with neither `NODE_AUTH_TOKEN` nor the OIDC request env, the script
degrades to a loud dry run.

## Nightlies

Every night at **03:17 UTC**, [`nightly.yml`](../.github/workflows/nightly.yml)
verifies `main` (typecheck, unit suites, build, packaged-CLI e2e — the same gate
a release runs) and publishes it under the `nightly` dist-tag:

```bash
npx cezarion@nightly              # whatever is on main as of last night
npx cezarion@0.1.5-nightly.20260813.126   # that exact night, forever
```

The version is named after the **day it was cut** — `<base>-nightly.<YYYYMMDD>.<run_number>`
— so the version list reads as a calendar and a user can tell how old their build
is without looking anything up. The run number trails the date so an on-demand cut
never collides with the scheduled one; both are numeric semver identifiers, so the
ordering stays chronological.

**Manual runs:** Actions → Nightly → *Run workflow* (from `main`). It publishes
immediately, even if nothing has merged since the last one — that's what the
`force` input defaults to. A *scheduled* run skips itself when `main` has not moved
in 24 hours, because that build is already the one tagged `nightly`.

The channel is requested **by name** (`CEZ_RELEASE_CHANNEL=nightly`), never inferred
from the event, so no other workflow's manual dispatch can cut a nightly by accident;
`computeSnapshot` additionally re-checks that the ref is `main`. Nightlies are
prereleases under an explicit dist-tag like every other snapshot — they can never
become the default install.

## Preview channels

| Event | Version (example) | dist-tag | Install |
|---|---|---|---|
| same-repo PR, CI green | `0.1.5-pr482.123` | `pr-482` | `npx cezarion@0.1.5-pr482.123` |
| push to `develop` | `0.1.5-develop.124` | `develop` | `npx cezarion@develop` |
| nightly cut of `main` | `0.1.5-nightly.20260813.126` | `nightly` | `npx cezarion@nightly` |

A push to `main` publishes **nothing**: the trunk reaches npm through the nightly
above, or through an owner-driven stable release — never straight off a merge.

Version scheme: `<base>-<channel>.<run_number>`, with `.<run_attempt>` appended
on re-runs so no publish ever collides. Prerelease versions under explicit
dist-tags are invisible to a plain `npx cezarion`, which keeps resolving
`latest`.

Every package publishes in lockstep, in dependency order, with each intra-release
dependency **pinned to the exact snapshot version** — so a preview always runs
exactly the code it was built from. Names are read from the checked-out manifests
at publish time, never hardcoded, and the pin is rewritten in whichever dependency
section declares it, so moving a dependency between `dependencies` and
`devDependencies` needs no change here.

On every PR snapshot the job upserts one sticky comment (marker
`<!-- cezar-npm-preview -->`) with the exact copy-pasteable commands. When a PR
closes, [`npm-preview-cleanup.yml`](../.github/workflows/npm-preview-cleanup.yml)
best-effort removes its `pr-<N>` dist-tag from every package (the versions
themselves stay — npm allows unpublish only within 72 hours, and untagged
prereleases are inert).

## Pieces

| Piece | Role |
|---|---|
| `packages/cezar/src/release/snapshot.ts` | pure decisions: channel/version/dist-tag, install lines (unit-tested) |
| `packages/cezar/src/release/manifests.ts` | the shared stamper: which manifests exist, and how each pins the next (unit-tested) |
| `scripts/release.mjs` | stable orchestrator: stamps manifests, `npm publish --tag latest` via OIDC, no `--provenance` (e2e-tested) |
| `scripts/release-snapshot.mjs` | snapshot orchestrator: stamps manifests, `npm publish --tag <channel> --provenance` with `NPM_TOKEN`, emits result JSON (`--dry-run` supported; e2e-tested) |
| `ci.yml` → `publish-snapshot` | gate (`needs: verify`), same-repo guard, provenance permissions, sticky PR comment, step summary |
| `nightly.yml` | the 03:17 UTC cron + manual dispatch: main-only guard, "did main move?" check, full verify, then the same orchestrator with `CEZ_RELEASE_CHANNEL=nightly` |
| `npm-preview-cleanup.yml` | dist-tag removal on PR close |

Guards: the job runs only for pushes and same-repo PRs (fork PRs get no
secrets, and `computeSnapshot` re-checks the head repo as defense in depth);
the dist-tag is always explicit so a snapshot can never become `latest`;
concurrency is non-cancellable so a publish never stops part-way through the
set (and if it ever did, the alias — published last — is the one users install,
so its tag only moves once everything below it is on the registry). **Without the `NPM_TOKEN` secret a snapshot or nightly degrades to a loud dry
run and stays green** — those jobs still need the token (OIDC is only configured
for `release.yml`). A stable release with no trusted publisher fails, it does
not dry-run.

## One-time admin setup

On **npmjs.com**, signed in as the account that owns the `@wjarka` scope:

1. Both published names already exist (`v0.11.0` created them). A user scope
   belongs to the npm account of the same name, so `@wjarka/*` needs no org
   and no team setup.
2. For **each** of `@wjarka/cezarion` and `cezarion`: Settings → *Trusted
   Publisher* → GitHub Actions, then:
   - Organization or user: `wjarka`
   - Repository: `cezar`
   - Workflow filename: `release.yml` (filename only, including the extension)
   - Environment name: `production` (must match `release.yml`'s `environment:`)
   - Allowed actions: `npm publish`
   npm does not verify this form when you save it; a mismatch only shows up as
   `ENEEDAUTH` on the next stable release. Configure both packages **before**
   the next `Release` run — that job no longer carries a token, so a missing
   publisher is a failed publish, not a dry run.
3. Keep a **granular access token** for the channels OIDC cannot cover
   (snapshots, nightlies, `npm dist-tag rm`). *Read and write*, **selected
   packages** `cezarion` and `@wjarka/cezarion` only — both names exist, so
   "all packages" / "able to create" is no longer needed. Set an expiry per
   your policy (CI fails loudly with `E401`/`E404`/`EOTP` when it is wrong
   or lapses).
   - **Tick "Bypass two-factor authentication (2FA)"** under the token's
     *Security settings*. A granular token is NOT exempt from 2FA by default —
     the bypass is an explicit opt-in checkbox, and without it an account that
     enforces 2FA on writes makes the registry answer `npm error code EOTP`
     (one-time password required). It aborts *after* uploading the file list,
     so it reads like a mid-publish glitch rather than a credential problem.
     Hit live on #30: a token with read-write on all packages and the bypass
     box left unchecked failed with `EOTP` on `@wjarka/cezarion`. Correct
     scope is not sufficient; this box is the other half.
   - Do **not** answer an `EOTP` by relaxing the account's two-factor mode to
     *authorization only*. That weakens every package the account owns to fix
     one CI job; set the bypass on the token instead, which is scoped to that
     token alone. A classic *Automation* token bypasses 2FA by design and is
     the other valid answer, at the cost of no expiry and account-wide write.
   - Do **not** set Publishing access to *"Require two-factor authentication
     and disallow tokens"*. That is npm's "maximum security" recommendation
     once *every* publish is OIDC; here the token still has to publish
     prereleases and remove dist-tags. Leave it at *"Require two-factor
     authentication or an automation or granular access token"*.
   - npm has no "prerelease-only" token permission. A leaked `NPM_TOKEN` can
     still `npm publish --tag latest`. What the narrowing actually buys: the
     token can no longer create new packages, and only the preview / nightly /
     cleanup jobs receive it. Those jobs never pass `--tag latest`. The
     trusted publisher is the intended `latest` path, not an exclusive one.
4. After rotating the token, for every package: Settings → *Publishing access*
   → **"Require two-factor authentication or an automation or granular access
   token"** (preview CI publishes with the token; humans still need 2FA).

On **GitHub** (this repository):

5. Settings → Secrets and variables → Actions → repository secret **`NPM_TOKEN`**
   with the narrowed token from step 3. Rotate the existing value rather than
   adding a second secret. `release.yml` does not read this secret.
6. Nothing else — the workflows declare their own `permissions:` blocks, so
   repo-level Actions defaults can stay read-only. The `production` environment
   already gates the Release workflow; add reviewers there if a release should
   require approval.

Nothing is deprecated on the upstream side: this clone publishes under names npm
has never seen, so `@open-mercato/cezar` and `cezar-cli` keep belonging to
upstream and are never written to from here.

## Verifying a preview

- The PR's sticky comment (or the job's step summary for branch pushes) has
  the exact command — e.g. `npx cezarion@0.1.5-pr482.123`.
- `npm view cezarion dist-tags` and `npm view @wjarka/cezarion dist-tags` show
  every active channel on both published names.
- Server flows accept pinned previews too:
  `npx cezarion@<version> server-deploy --platform <id>`
  (see [Remote access](server-install/README.md)).
