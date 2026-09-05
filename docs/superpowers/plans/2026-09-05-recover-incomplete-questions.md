# Recover incomplete questions Implementation Plan

> Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recover bounded syntax truncation with visible diagnostics without changing monitoring.
**Architecture:** Port the parser and diagnostic portions of upstream aa8d6b2f; adapt only question resolution in both fork turn handlers.
**Tech Stack:** TypeScript, Zod, React, Vitest.
**Spec:** `.ai/specs/2026-09-05-recover-incomplete-questions.md`

## Global constraints
Preserve @wjarka/cezarion, alias-cezarion, version lineage, strict ask structure and all fork wake behavior.

## Task 1: Parser and diagnostics
- [x] Port upstream regression cases in core/ask.test.ts, workflows/run.test.ts, thread-state.test.ts and the mock:ask-truncated fixture.
- [x] Run `npm test -- packages/cezar/src/core/ask.test.ts packages/cezar/src/workflows/run.test.ts packages/web/src/routes/task-thread/thread-state.test.ts` and confirm recovery and tone expectations fail before source changes.
- [x] In core/ask.ts append missing closers using a string/escape-aware stack, reparse, preserve schema validation, add repaired boolean to valid results, and strip validated repaired markers.
- [x] In workflows/run.ts add resolveAskTurn(turnText, enabled) returning ask plus ordered danger notes; replace only askResult/askRejection in both handlers. Preserve monitoring expressions and sawClaudeScheduleWakeup resets verbatim.
- [x] In thread-state.ts map note tone danger to existing danger presentation, defaulting everything else to dim.
- [x] Rerun targeted tests plus harness-parity and monitoring-wake tests.

## Task 2: Documentation and release verification
- [x] Update protocol, compatibility notes and Unreleased changelog with bounded recovery and persistent information-loss warning.
- [x] Check existing diagnostic appearance at 360px and desktop in light/dark themes.
- [x] Run in order: npm run typecheck; npm test; npm run test:unit; npm run build; npm run test:package.
- [ ] Review diff against fork monitoring and package identity; commit, push, open draft PR closing #88 and move board to In review.
- [ ] Run pr-checks to CI/review verdict; preserve draft state and update handoff.

## Implementation evidence

Initial regressions: 12 failures before production changes. Review regressions: 3 failures before fixes, then 122 parser/reducer tests pass. Keep repairable raw v1 events (allowRepair=false) until card-gated display stripping; this preserves fallback if later chunks invalidate a prefix. Both v1 and v2 display paths are covered.

All five validation commands passed; Vitest 337 files / 6582 tests, node unit gates 37 + 60 tests, package suite 21 tests. One first-run GitHub template flake passed in isolation and on the full rerun. Browser component QA at 360×640 and 1280×640 in light/dark: recovery and rejection notes wrap without overflow; light notes use red-700 for readable contrast. No new controls, motion, or art. Independent review has no remaining findings.
