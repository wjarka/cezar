# OpenCode Question Ask Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge OpenCode's native `question` tool to Cezar's existing `ask.requested` card and route the next user message back to OpenCode's question reply endpoint.

**Architecture:** Keep the bridge inside `OpencodeSession`, where both the OpenCode SSE tool event and the next `AgentSession.sendMessage` already meet. Convert untrusted OpenCode question input into the existing `AskQuestion` shape, discover the pending OpenCode request by session ID, emit the existing UI event, and retain only enough state to answer the request. No contract or cockpit change is needed because both already support `ask.requested`.

**Tech Stack:** TypeScript, Node HTTP/fetch, Vitest, OpenCode serve HTTP/SSE protocol.

**Spec:** `.ai/specs/2026-07-18-askuser-across-runners.md` plus GitHub issue `wjarka/cezar#6` and its approved native-bridge design.

## Global Constraints

- Preserve the v1 `AgentEvent` stream and emit native questions only through the existing v2 `ask.requested` event.
- Preserve `prompt_async` plus `session.idle` as the only normal OpenCode turn lifecycle.
- Accept 1 to 4 questions and 2 to 4 options per retained question; cap headers at 12 characters, question text at 400, labels at 60, and descriptions at 280.
- A missing request ID or failed reply must emit a visible `note`; it must not silently submit the text as a new prompt.
- Add no dependency, HTTP API route, persisted shape, environment variable, or cockpit component.

---

### Task 1: Native OpenCode Question Bridge

**Files:**
- Modify: `packages/cezar/src/core/opencode-server-runner.ts:81-705`
- Test: `packages/cezar/src/core/opencode-server-runner.test.ts:157-466`
- Modify: `AGENT_PROTOCOL.md:247-264,278-289`

**Interfaces:**
- Consumes: `AskQuestion` and `parseAskRequest` from `packages/cezar/src/core/ask.ts`; OpenCode `GET /question` records shaped as `{ id, sessionID }`; OpenCode `POST /question/:requestId/reply` body shaped as `{ answers: string[][] }`.
- Produces: existing `UiAskRequestedEvent` `{ type: 'ask.requested'; requestId: string; questions: AskQuestion[] }`; private pending state `{ requestId?: string; questions: AskQuestion[] }`; no new exported API.

- [x] **Step 1: Extend the mock server and write failing mapping/reply tests**

Update the test harness to collect request bodies and serve a mutable pending-question list:

```ts
const questionGets: number[] = [];
const questionReplies: Array<{ path: string; body: unknown }> = [];
let pendingQuestions: unknown[] = [];

if (req.method === 'GET' && url === '/question') {
  questionGets.push(Date.now());
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(pendingQuestions));
  return;
}

if (req.method === 'POST' && /^\/question\/[^/]+\/reply$/.test(url)) {
  questionReplies.push({ path: url, body: JSON.parse(body || '{}') });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
  return;
}
```

Start the session with `onUiEvent`, send a `message.part.updated` tool part named `question`, and assert:

```ts
expect(asks).toEqual([{
  type: 'ask.requested',
  requestId: 'q_test',
  questions: [{
    header: 'Architecture', // expected to be clipped to 12 characters
    question: 'Which test framework?',
    options: [
      { label: 'Vitest', description: 'Use the existing suite' },
      { label: 'Node test', description: 'Use node:test' },
    ],
    multiSelect: true,
  }],
}]);
```

Call `session.sendMessage([{ type: 'text', text: 'Architecture: Vitest, Node test' }])`, then assert the runner posts:

```ts
expect(questionReplies).toEqual([{
  path: '/question/q_test/reply',
  body: { answers: [['Vitest', 'Node test']] },
}]);
expect(mock.promptPosts).toHaveLength(1);
```

- [x] **Step 2: Write failing fallback and missing-ID tests**

Add one test where two mapped questions are emitted and the reply is plain text. Assert the reply body is `{ answers: [['Use sensible defaults'], []] }`.

Add one test where all eight pending-request polls return no matching session record. Send the answer, assert one final lookup occurs, no reply POST and no second prompt occurs, and v1 includes:

```ts
{ type: 'note', message: 'opencode: question reply failed: no pending question id' }
```

Include overlong headers, question text, labels and descriptions plus more than four options in the mapping input. Assert the emitted event satisfies the exact caps and retains at most four options. Include an invalid question with fewer than two usable options and assert it is omitted.

- [x] **Step 3: Run the focused tests to verify they fail**

Run: `npm test -- packages/cezar/src/core/opencode-server-runner.test.ts`

Expected: FAIL because no `ask.requested` is emitted, `/question` is never queried, and answers are posted as a second prompt instead of a question reply.

- [x] **Step 4: Implement input mapping and answer parsing**

Import `AskQuestion` and `parseAskRequest` from `./ask.ts`. Add private helpers with these signatures:

```ts
function toCezarQuestions(value: unknown): AskQuestion[] | null
function questionAnswers(questions: AskQuestion[], text: string): string[][]
```

`toCezarQuestions` must:

- Iterate at most four input questions.
- Ignore malformed questions and options instead of throwing.
- Trim non-empty option labels, clip display fields to schema caps, map OpenCode `multiple: true` to `multiSelect: true`, and retain at most four options.
- Use `parseAskRequest({ questions })` as the final validity and uniqueness gate; return `null` when no valid question remains.

`questionAnswers` must:

- Match exact `Header:` prefixes line-by-line.
- Split comma-separated values and trim empty entries.
- If no header line matches, put the complete trimmed text into the first question's answer array and return empty arrays for later questions.

- [x] **Step 5: Implement pending-request discovery and ask emission**

Add session state:

```ts
private pendingQuestion: { requestId?: string; questions: AskQuestion[] } | undefined;
private questionCapture: Promise<void> | undefined;
```

When a main-session tool part named `question` first appears, call a private `captureQuestion(input)` method. Deduplicate repeated tool status updates with `questionCapture` and `pendingQuestion`.

`captureQuestion` must poll `GET /question` up to eight times, 150 ms apart, select the record whose `sessionID` equals `this.sessionId`, and remember its string `id` when available. Emit one `ask.requested` with that ID or a unique `opencode-...` display fallback when lookup is exhausted. Do not emit when input mapping returns `null`.

- [x] **Step 6: Implement reply interception and failure notes**

In `sendMessage`, after extracting non-empty text and before calling `prompt`, atomically clear and consume `pendingQuestion`:

```ts
if (this.pendingQuestion) {
  const pending = this.pendingQuestion;
  this.pendingQuestion = undefined;
  void this.replyQuestion(pending, text);
  return true;
}
```

`replyQuestion` must retry one `GET /question` lookup when capture had no request ID. If no matching ID exists, emit the required missing-ID note and return without calling `prompt`. Otherwise POST `{ answers: questionAnswers(...) }` to `/question/:id/reply`; catch errors and emit `opencode: question reply failed: <message>` as a v1 note.

Clear `pendingQuestion` and `questionCapture` in `finishTurn` so an aborted, failed, or completed turn cannot consume a later prompt.

- [x] **Step 7: Run focused tests to verify the bridge passes**

Run: `npm test -- packages/cezar/src/core/opencode-server-runner.test.ts`

Expected: PASS, including existing prompt serialization, foreign-session filtering, SSE failure, and teardown cases.

- [x] **Step 8: Update protocol documentation**

Update `AGENT_PROTOCOL.md` so the AskUser section states that OpenCode bridges its native `question` tool through `GET /question` and `POST /question/:id/reply`. Add native OpenCode question bridging to the per-backend mapping table without changing the portable `CEZ:ASK` baseline or implying a new protocol event.

- [x] **Step 9: Run repository verification**

Run in order:

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Expected: every command exits 0. No browser E2E run is required because no cockpit code changes; existing ask-card behavior is exercised by its unit suite and this change only supplies the existing event.

- [x] **Step 10: Commit the logical change**

```bash
git add AGENT_PROTOCOL.md docs/superpowers/plans/2026-09-02-opencode-question-ask-card.md packages/cezar/src/core/opencode-server-runner.ts packages/cezar/src/core/opencode-server-runner.test.ts
git commit -m "feat(opencode): surface native questions as ask cards"
```
