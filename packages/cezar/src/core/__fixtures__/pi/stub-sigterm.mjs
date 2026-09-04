#!/usr/bin/env node
import readline from 'node:readline';
let exitCode = 143;
process.on('SIGTERM', () => process.exit(exitCode));
process.stderr.write('[apptension-dev] no selector found; no skills registered\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
// Ignore EOF so end() must exercise its existing SIGTERM watchdog.
setInterval(() => {}, 1000);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-teardown' } });
  }
  if (command.type !== 'prompt') continue;
  if (/exit-1\b/.test(command.message)) exitCode = 1;
  send({ type: 'agent_start' });
  send({ type: 'turn_start' });
  if (command.message.includes('provider-error')) {
    send({ type: 'message_end', message: {
      role: 'assistant', content: [], provider: 'openai-codex', model: 'gpt-5.6-sol',
      stopReason: 'error', errorMessage: 'WebSocket error',
    } });
  } else {
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] } });
  }
  send({ type: 'agent_settled' });
  if (command.message.includes('self-exit')) process.exit(143);
}
