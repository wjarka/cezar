import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent, UiMessageItem } from './ui-events.js';
import {
  createPiUiState,
  mapPiRpcMessage,
  piTurnStarted,
  type PiUiMapperState,
  type PiUiMapping,
} from './pi-ui-mapper.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'pi');

function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: PiUiMapperState = createPiUiState();
  const events: UiEvent[] = [];
  const push = (mapped: PiUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  push(piTurnStarted(state));
  for (const line of lines) push(mapPiRpcMessage(JSON.parse(line), state));
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

describe('pi RPC → v2 golden fixture', () => {
  it('maps the wire-faithful lifecycle exactly', () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'rpc-lifecycle.expected.json'), 'utf8'));
    expect(replay('rpc-lifecycle')).toStrictEqual(expected);
  });

  it('malformed and unknown RPC messages are ignored without throwing', () => {
    const state = createPiUiState();
    for (const value of [null, 42, [], {}, { type: 'future_event' }]) {
      const mapped = mapPiRpcMessage(value, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('maps upstream model stop reasons onto the normalized turn reason', () => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'done', reason: 'length', message: {} },
      },
      state,
    ).state;
    expect(mapPiRpcMessage({ type: 'agent_settled' }, state).events).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'max_tokens' },
    ]);
  });
});

function feed(messages: unknown[]): UiEvent[] {
  let mapped = piTurnStarted(createPiUiState());
  const events = [...mapped.events];
  let state = mapped.state;
  for (const value of messages) {
    mapped = mapPiRpcMessage(value, state);
    events.push(...mapped.events);
    state = mapped.state;
  }
  return events;
}

function textUpdate(type: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'message_update',
    assistantMessageEvent: { type, contentIndex: 0, ...extra },
  };
}

function completedMessages(events: UiEvent[]): UiMessageItem[] {
  return events.flatMap((e) =>
    e.type === 'item.completed' && e.item.kind === 'message' ? [e.item] : [],
  );
}

describe('pi text blocks as distinct v2 items', () => {
  it('does not start an item for a text_start that carries neither a delta nor an end', () => {
    const events = feed([textUpdate('text_start')]);
    expect(events.filter((e) => e.type !== 'turn.started')).toEqual([]);
  });

  it('renders prose before and after a tool as two completed messages when both use contentIndex 0', () => {
    const events = feed([
      textUpdate('text_delta', { delta: 'before' }),
      textUpdate('text_end', { content: 'before' }),
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } },
      {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'read',
        isError: false,
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
      textUpdate('text_delta', { delta: 'after' }),
      textUpdate('text_end', { content: 'after' }),
    ]);
    const completed = completedMessages(events);
    expect(completed.map((item) => item.text)).toEqual(['before', 'after']);
    expect(completed[0]!.id).not.toBe(completed[1]!.id);
  });

  it('closes a dangling open text item exactly once when the turn completes', () => {
    const events = feed([textUpdate('text_delta', { delta: 'partial' }), { type: 'agent_settled' }]);
    const completed = completedMessages(events);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.text).toBe('partial');
    const settleAt = events.findIndex((e) => e.type === 'turn.completed');
    expect(events[settleAt - 1]).toMatchObject({ type: 'item.completed', item: completed[0] });
  });

  it('does not complete an already-ended text item again on turn completion', () => {
    const events = feed([
      textUpdate('text_delta', { delta: 'hi' }),
      textUpdate('text_end', { content: 'hi' }),
      { type: 'agent_settled' },
    ]);
    expect(completedMessages(events)).toHaveLength(1);
  });

  it('ignores a malformed tool_execution_start without closing open text', () => {
    const events = feed([
      textUpdate('text_delta', { delta: 'partial' }),
      { type: 'tool_execution_start' },
      { type: 'agent_settled' },
    ]);
    expect(events.some((e) => e.type === 'item.started' && e.item.kind === 'tool')).toBe(false);
    const completed = completedMessages(events);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.text).toBe('partial');
  });
});
