#!/usr/bin/env node
import readline from 'node:readline';

const sessionId = '00000000-0000-4000-8000-0000000000pi';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({
      id: command.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        sessionId,
        thinkingLevel: 'medium',
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'all',
        followUpMode: 'one-at-a-time',
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
  } else if (command.type === 'prompt') {
    const monitoringMarker = command.message.includes('mock:monitoring') ? '\n\nCEZ:MONITORING' : '';
    const responseText = `Investigating: ${command.message}${monitoringMarker}`;
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    send({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
    });
    send({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: responseText,
        partial: {},
      },
    });
    send({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_end',
        contentIndex: 0,
        content: responseText,
        partial: {},
      },
    });
    send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } });
    send({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'mock file' }] },
      isError: false,
    });
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.001 },
        },
      },
    });
    send({ type: 'turn_end', message: {}, toolResults: [] });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
    if (command.message.includes('mock:backend-resume-text')) {
      setTimeout(() => {
        send({
          type: 'message_update',
          message: {},
          assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
        });
        send({
          type: 'message_update',
          message: {},
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'Pi resumed without a prompt',
            partial: {},
          },
        });
        send({
          type: 'message_update',
          message: {},
          assistantMessageEvent: {
            type: 'text_end',
            contentIndex: 0,
            content: 'Pi resumed without a prompt',
            partial: {},
          },
        });
      }, 250);
    } else if (command.message.includes('mock:backend-resume')) {
      setTimeout(() => {
        send({
          type: 'tool_execution_start',
          toolCallId: 'pi-autonomous-edit',
          toolName: 'edit',
          args: { path: 'src/a.ts', oldText: 'old', newText: 'new' },
        });
        send({
          type: 'tool_execution_end',
          toolCallId: 'pi-autonomous-edit',
          toolName: 'edit',
          result: { content: [{ type: 'text', text: 'updated' }] },
          isError: false,
        });
      }, 250);
    }
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
