# Model-Specific Effort Levels Design

**Issue:** [#55](https://github.com/wjarka/cezar/issues/55)

## Goal

Show only the effort levels supported by the selected model while preserving `auto` and the current full-list behavior whenever trustworthy model metadata is unavailable.

## Scope

This change extends Pi and OpenCode model discovery, the existing model catalog contract and cache, and every cockpit surface that combines a model picker with an effort picker. It does not add effort defaults to Settings, validate effort again on the server at submission time, or change runner effort mappings.

## Canonical vocabulary

Cezar continues to use the ordered canonical levels defined in `packages/contract/src/effort.ts`:

```text
low, medium, high, xhigh, max
```

`auto` remains a cockpit-only choice represented by the empty string and omitted from create/continue requests. Discovery metadata never includes `auto`.

Each model catalog option gains an optional ordered `effortLevels` array. The array contains only canonical levels, with duplicates removed. The field remains optional so old servers, cached values, Codex discovery, Claude presets, custom model IDs, and unavailable discovery all preserve existing behavior.

## Discovery

### Pi

Pi exposes model-specific thinking choices through its RPC protocol. Discovery will keep `pi --list-models` as the bounded source of model IDs and order, then use one additional bounded Pi RPC child to issue a `set_model` / `get_available_thinking_levels` pair for each listed model. Cezar will preserve Pi's model order and Pi's level order, normalize recognized values to the canonical vocabulary, and omit unsupported Pi-only values such as `off` or `minimal`.

A failure to obtain usable levels for one model must not discard metadata for another model. That model is returned without `effortLevels` and uses the cockpit fallback. If the enrichment RPC process is unavailable or malformed, the already-discovered model list is still returned without effort metadata; only failure of the base `--list-models` probe keeps the model catalog's existing unavailable or stale-cache behavior. Both children are covered by one ten-second discovery deadline and separate 512 KiB output caps, preserve the 500-model cap, and use graceful SIGTERM followed by SIGKILL. An unconfigured dry run spawns neither real host process.

The existing `parsePiModels` table parser remains the source of the base model list and keeps its established issue #1 behavior and tests.

### OpenCode

OpenCode exposes model variants in `opencode models --verbose`. Discovery will parse each model ID and its following JSON metadata block. Recognized variant names map directly to canonical effort levels; `none`, `minimal`, `default`, and unknown names do not become Cezar choices. The parser preserves model order and variant order.

Malformed metadata is isolated per model. A valid model ID still appears without `effortLevels` when its metadata is absent, empty, malformed, or contains no recognized variants. A partially recognized variant map keeps the recognized canonical subset and drops unknown entries. Existing timeout, output, model-count, duplicate, and process-teardown guarantees remain unchanged.

## Contract, cache, and API

`runnerModelOptionSchema` adds:

```ts
effortLevels: z.array(effortLevelSchema).optional()
```

The server-side `ModelOption` uses the contract's inferred `EffortLevel` type rather than a second vocabulary. `RunnerModelCatalog` continues to cache complete `ModelOption[]` values, so the metadata follows the existing live, fresh-cache, stale-cache, and unavailable paths without a second cache or endpoint.

`GET /api/v1/models` returns the optional field exactly when discovery produced it. The route remains workspace-level, keeps the same query validation, and remains backward-compatible with clients and cached results that omit the field.

## Cockpit resolution

A shared pure helper resolves effort options from `(runner, selectedModel, catalog)`:

1. Always prepend `auto`.
2. If the selected catalog model has a non-empty recognized `effortLevels` array, append exactly those levels in recorded order.
3. Otherwise append the existing fallback order: `low`, `medium`, `high`, `xhigh`, `max`.

The fallback is per model. Missing metadata on one model never changes another model's options. Claude, Codex, custom or legacy IDs, empty catalogs, stale older cached values, and servers that predate this field therefore retain today's full list.

A companion resolver accepts the current effort and the resolved options. It returns the effort when supported and returns the empty-string `auto` value otherwise. The visible picker value and the submitted value both use this resolved value, so stale state cannot reach a request.

## Picker surfaces and state transitions

The behavior applies to all existing effort pickers:

- the `/new` task composer;
- shared `EnginePills` used by Inbox and GitHub handoff surfaces;
- the task-thread Continue composer.

When a model or runner changes, the surface clears a selected effort that the new effective model does not support. If asynchronous catalog data later proves a persisted or prior selection invalid, derived resolution immediately displays and submits `auto`, even before state synchronization. This guarantees the reset before submission and prevents a render/effect race.

Continue keeps its existing untouched-field semantics: an untouched valid run effort is omitted from the request so the run keeps its pin. If a model change makes that inherited effort invalid, Continue explicitly sends an empty effort only when needed to clear the stored pin before starting the new model. A user-selected valid effort is sent as today.

`modelsLocked` remains authoritative: model and effort controls stay read-only and requests omit both overrides.

## Error handling and compatibility

Discovery remains best-effort and zero-config. Unsupported CLI versions, malformed verbose output, missing metadata, older API responses, and custom models degrade to the full fallback list rather than disabling effort selection or failing boot.

No new environment variable, dependency, route, persistent state, migration, or configuration file is introduced.

## Experience checklist

The change reuses existing compact `PickerPill` controls and their wrapping footer layout. It adds no new UI state, imagery, or motion. Existing keyboard menu behavior, accessible `Effort` labels, light/dark tokens, reduced-motion behavior, and mobile wrapping at approximately 360 px remain unchanged. Tests will verify the picker remains operable through semantic roles rather than visual selectors alone.

## Testing

Implementation follows test-driven development. Focused tests will cover:

- Pi RPC model-level thinking choices, normalization, per-model isolation, bounds, and dry-run behavior;
- OpenCode verbose variant parsing, order, recognized subsets, duplicates, malformed/empty/unknown per-model metadata, and existing process bounds;
- contract inference/parity and API serialization of `effortLevels`;
- cache retention through live, fresh, and stale values;
- the shared cockpit option and effort resolver, including old/missing metadata and custom IDs;
- `/new`, Inbox/GitHub `EnginePills`, and Continue filtering;
- model and runner changes clearing unsupported effort before create or continue submission;
- unchanged fallback behavior for Claude, Codex, old servers, and unavailable discovery.

Before the draft pull request, run the repository's complete verification sequence from `AGENTS.md` in order.
