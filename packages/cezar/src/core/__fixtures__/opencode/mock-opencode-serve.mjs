#!/usr/bin/env node
// Test-only mock of `opencode serve` — speaks just enough of the HTTP+SSE
// API (§4 of agent-event-protocols.md) for the runner wiring test in
// `opencode-ui-mapper.test.ts`: POST /session, GET /event (SSE bus), one
// scripted prompt turn. Like the real server's `prompt_async`, the HTTP
// response resolves immediately — every part and the closing `session.idle`
// arrive over SSE afterwards, so a correct stream (v1 and v2 alike) must
// take its turn-end from `session.idle`, never from the HTTP response.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const hostname = arg('--hostname', '127.0.0.1');
const port = Number(arg('--port', '0'));

const SESSION_ID = 'ses_mock_1';
const MESSAGE_ID = 'msg_mock_1';

let sse = null;
const send = (event) => {
  if (sse) sse.write(`data: ${JSON.stringify(event)}\n\n`);
};
const info = (extra) => ({
  id: MESSAGE_ID,
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created: 1760000000000 },
  modelID: 'mock-model',
  providerID: 'mock',
  mode: 'build',
  path: { cwd: '/repo', root: '/repo' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
});

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url.startsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse = res;
    send({ type: 'server.connected', properties: {} });
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && url === '/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: SESSION_ID, title: 'cezar task' }));
      return;
    }
    if (
      req.method === 'POST' &&
      (url === `/session/${SESSION_ID}/prompt_async` || url === `/session/${SESSION_ID}/message`)
    ) {
      // `prompt_async` semantics: acknowledge now, stream the turn over SSE.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ info: info({}), parts: [] }));
      // The raw body is enough to spot a `mock:` marker — the prompt text is
      // inside it whatever part shape the runner used to wrap it.
      if (body.includes('mock:split-text')) {
        // OpenCode streams a text part as successive GROWING snapshots of the
        // same part id; only the final one carries `time.end`. A runner emitting
        // one v1 `text` per snapshot publishes the torn `…CEZ:` prefix, which is
        // #2 on opencode's wire (harness parity S8).
        const full = 'parity split text\n\nCEZ:MONITORING';
        send({ type: 'message.updated', properties: { info: info({}) } });
        for (const upto of [17, 24, full.length]) {
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_split', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
            text: full.slice(0, upto),
            ...(upto === full.length ? { time: { start: 1760000000500, end: 1760000000600 } } : {}),
          } } });
        }
        send({ type: 'message.updated', properties: { info: info({
          cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }) } });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        return;
      }
      if (body.includes('mock:hold')) {
        // The response above is the ack (this is the #4 wire: `prompt_async`
        // resolves immediately, the turn arrives over SSE afterwards). Holding
        // the content behind it is what makes harness parity S2 meaningful.
        setTimeout(() => {
          const held = 'parity hold: content after the pause';
          send({ type: 'message.updated', properties: { info: info({}) } });
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_hold', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: held,
          } } });
          send({ type: 'message.updated', properties: { info: info({
            cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          }) } });
          setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        }, 250);
        return;
      }
      send({ type: 'message.updated', properties: { info: info({}) } });
      send({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_mock_t1', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Checking the working tree.' },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: { status: 'pending', input: { command: 'git status --short' }, raw: '{}' },
          },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: { status: 'running', input: { command: 'git status --short' }, title: 'git status --short', time: { start: 1760000000100 } },
          },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'git status --short' },
              output: ' M src/example.ts\n',
              title: 'git status --short',
              metadata: { exit: 0 },
              time: { start: 1760000000100, end: 1760000000400 },
            },
          },
        },
      });
      send({
        type: 'message.updated',
        properties: {
          info: info({ cost: 0.0021, tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } } }),
        },
      });
      setTimeout(() => {
        send({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'prt_mock_t2',
              messageID: MESSAGE_ID,
              sessionID: SESSION_ID,
              type: 'text',
              text: 'Done.',
              time: { start: 1760000000500, end: 1760000000600 },
            },
          },
        });
      }, 30);
      setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 90);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

server.listen(port, hostname, () => {
  // The runner reads the bound URL back from stdout, like the real server.
  console.log(`opencode server listening on http://${hostname}:${port}`);
});
process.on('SIGTERM', () => process.exit(0));
