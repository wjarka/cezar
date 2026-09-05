# Codex 0.147 provider rejection (#83)

`provider-error.rollout.json` is line 9 of the original rollout
`rollout-2026-09-05T20-18-48-01a072cb-6856-73a3-88cc-d91d0a322c0b.jsonl`.
Cezar run `e68f1db0-3b84-49e4-b018-16e0a858c447` recorded this turn as
`end_turn`, with no text or usage, and parked for user input.

The rollout is a core `task_complete` event, not an app-server notification.
`provider-error.ndjson` reconstructs the app-server envelope using Codex
[rust-v0.147.0 bespoke_event_handling.rs](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/bespoke_event_handling.rs):
`handle_turn_complete` selects failed status and the stored error;
`emit_turn_completed_with_status` puts them inside `turn` on `turn/completed`.
No last agent message yields `items: []` and `itemsView: notLoaded`.
The error message and timing values are copied from the rollout. Thread and
turn IDs are replaced with the mock session IDs. `codex_error_info` becomes
`codexErrorInfo`, and absent additional details serialize as null.

The mock replays this completion for `mock:provider-error`. The older
`mock:turn-failed` remains available to protect legacy handling.
