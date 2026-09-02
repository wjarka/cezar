# OpenCode Question State Machine Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct OpenCode native-question handling so each tool part is handled once, concurrent user text is delivered in order, positional answer mapping remains safe, and unsupported requests cannot block a turn.

**Architecture:** Keep the correction inside `OpencodeSession`, where SSE question parts, reply HTTP requests, prompt serialization, and teardown already meet. Add durable handled-part identity and a reply-adjacent prompt queue, make question conversion all-or-nothing, and route invalid requests through the same bounded pending-ID lookup before rejecting or terminating.

**Tech Stack:** TypeScript, Node HTTP/fetch, Vitest, OpenCode serve HTTP/SSE protocol.

**Spec:** PR #26 automated review findings and `AGENT_PROTOCOL.md` section 3 (`AskUser`).

## Global Constraints

- Work only in the assigned worktree and do not dispatch subagents or reviewers.
- Preserve main-session filtering, turn-serial stale-capture rejection, guarded v2 emission, reply retry behavior, and `prompt_async`/`session.idle` serialization.
- Follow strict TDD: focused integration tests and observed RED before production edits, then focused GREEN.
- Run `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, and `npm run test:package` in that order.
- Commit the complete correction once with a Conventional Commit; do not push.

---

### Task 1: Focused Integration Regressions

**Files:**
- Test: `packages/cezar/src/core/opencode-server-runner.test.ts`

**Interfaces:**
- Consumes: the existing in-process OpenCode HTTP/SSE harness and `AgentSession.sendMessage`.
- Produces: request traces for `/question/:id/reject`, prompt bodies, reply bodies, UI asks, notes/errors, turn ends, and session openness.

- [ ] **Step 1: Extend the mock without changing production behavior**

Record prompt request bodies, add a mutable delayed reply status, and implement `POST /question/:id/reject` collection with a successful JSON response.

- [ ] **Step 2: Add one-shot handled-part coverage**

Answer a valid question successfully, send a completed snapshot with the same part ID before `session.idle`, and assert there is still one ask and one lookup. End that turn, start another prompt, send a different question part ID, and assert the later question is captured.

- [ ] **Step 3: Add ordered reply-adjacent message coverage**

Delay a successful reply, send two additional non-empty messages, and assert neither posts before `session.idle`; after idle, assert both reach `prompt_async` in order. Add a failed delayed reply case where queued text remains untouched while a later explicit answer retries the question, then assert the queued text posts only after retry success and idle.

- [ ] **Step 4: Add positional validation coverage**

Send malformed-first/valid-second native input with a discoverable request ID. Assert no ask and no reply are emitted, and that the request is rejected instead of shifting the second question to answer index zero.

- [ ] **Step 5: Add invalid-request liveness coverage**

Assert invalid input with a found ID posts `/question/:id/reject`, emits a visible note, and leaves the turn open for OpenCode's subsequent idle. Assert invalid input with no ID exhausts eight lookups, emits a visible error, ends the turn, and closes the session.

- [ ] **Step 6: Run the focused suite and record RED**

Run `npm test -- packages/cezar/src/core/opencode-server-runner.test.ts`. Expected failures: terminal recapture performs another lookup/ask; in-flight messages disappear; malformed-first input emits a shifted ask; no reject request is made; no-ID invalid input remains open.

---

### Task 2: Minimal State-Machine Correction

**Files:**
- Modify: `packages/cezar/src/core/opencode-server-runner.ts`
- Test: `packages/cezar/src/core/opencode-server-runner.test.ts`

**Interfaces:**
- Consumes: stable OpenCode part `id`/`callID`, bounded `pendingQuestionId`, existing `prompt`, and existing `finishTurn`/`end` lifecycle.
- Produces: no exported API; private handled-ID state, queued prompt text, strict native-question mapping, and invalid-request rejection/termination.

- [ ] **Step 1: Make question parts one-shot**

Derive the question identity from part `id`, then `callID`, then the existing message identity. Insert it into a session-lifetime handled set immediately before capture starts, so every later snapshot of that identity is ignored without suppressing a new identity in a later turn.

- [ ] **Step 2: Queue text while a reply is in flight**

Append non-empty text to a FIFO array when `questionReply` exists. On reply success, clear the pending ask and feed queued entries through `prompt`; its existing `turnActive` gate must hold every post until `session.idle`. On failure, retain the queue and pending ask so only a later newly submitted answer retries the reply.

- [ ] **Step 3: Make mapping positional and all-or-nothing**

Reject non-record input, non-array question lists, zero or more than four questions, any malformed question, any question with fewer than two usable options, and any final schema or uniqueness failure. Continue clipping display fields and retaining only the first four usable options inside each valid question.

- [ ] **Step 4: Resolve invalid upstream requests**

Perform bounded pending-ID lookup even when mapping returns null. If found, POST `/question/:id/reject` and emit a visible note. If absent after eight attempts, emit a visible error, call `finishTurn`, and end the session so neither Cezar nor OpenCode remains parked.

- [ ] **Step 5: Run focused GREEN**

Run `npm test -- packages/cezar/src/core/opencode-server-runner.test.ts`. Expected: all existing and new integration tests pass.

---

### Task 3: Verification, Review, Report, and Commit

**Files:**
- Review: all modified tracked files
- Create outside worktree as explicitly requested: `/home/agent/projects/cezar/.ai/cezar/tmp/7a0c3d3e-f093-43c9-be58-d140e77ccf26/opencode/pr26-review-fix-report.md`

**Interfaces:**
- Consumes: focused RED/GREEN output and repository verification output.
- Produces: one review report and one local Conventional Commit.

- [ ] **Step 1: Run repository verification in order**

Run `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, and `npm run test:package`, stopping to diagnose any failure before continuing.

- [ ] **Step 2: Self-review**

Inspect `git diff`, confirm only intended files changed, trace every question-state transition, and verify session filtering, stale-turn guards, v2 exception containment, retry restoration, and idle-gated prompt posting remain intact.

- [ ] **Step 3: Write the report**

Record implementation details, observed RED failures, focused GREEN, all five verification results, concerns, and the eventual commit identity at the requested report path.

- [ ] **Step 4: Commit once**

Inspect `git status`, `git diff`, and `git log --oneline -10`; stage only intended tracked changes and commit with `fix(opencode): correct native question state handling`. Do not push.
