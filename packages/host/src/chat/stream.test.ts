import { describe, expect, test } from 'vitest';
import { eventFrom, eventParser, type TurnEvent } from './stream.ts';

const CALL = {
  name: 'preview_plan',
  arguments: { intent: 'Away for the weekend' },
  result: {
    content: [{ type: 'text', text: 'Blocked.' }],
    structuredContent: { verdict: 'UNSAFE', tier: 'T3' },
  },
  resourceUri: 'ui://shadow-home/plan-view.html',
};

/** A typical preview turn, as the contract writes it. */
const PREVIEW_TURN = [
  ': connected',
  '',
  'event: text',
  'data: {"delta":"Let me check "}',
  '',
  'event: step',
  'data: {"id":"s1","tool":"preview_plan","label":"Checking the plan on your home\'s twin","state":"running"}',
  '',
  ': still working',
  '',
  'event: step',
  'data: {"id":"s1","tool":"preview_plan","label":"Checking the plan on your home\'s twin","state":"done"}',
  '',
  'event: call',
  `data: ${JSON.stringify({ call: CALL })}`,
  '',
  'event: text',
  'data: {"delta":"that first."}',
  '',
  'event: done',
  `data: ${JSON.stringify({ say: 'Blocked: that breaks 4 house rules.', calls: [CALL] })}`,
  '',
  '',
].join('\n');

describe('reading the event stream', () => {
  test('gives each event of a preview turn in order, skipping keep-alives', () => {
    const events = eventParser().push(PREVIEW_TURN);
    expect(events.map((e) => e.type)).toEqual(['text', 'step', 'step', 'call', 'text', 'done']);
    expect(events[1]).toEqual({
      type: 'step',
      id: 's1',
      tool: 'preview_plan',
      label: "Checking the plan on your home's twin",
      state: 'running',
    });
    expect(events[2]).toMatchObject({ type: 'step', id: 's1', state: 'done' });
    expect(events[3]).toEqual({ type: 'call', call: CALL });
    expect(events[5]).toEqual({
      type: 'done',
      turn: { say: 'Blocked: that breaks 4 house rules.', calls: [CALL] },
    });
  });

  test('gives the same events however the text is cut into chunks', () => {
    const whole = eventParser().push(PREVIEW_TURN);
    for (const size of [1, 2, 3, 7, 16, 61]) {
      const parser = eventParser();
      const events: TurnEvent[] = [];
      for (let i = 0; i < PREVIEW_TURN.length; i += size) {
        events.push(...parser.push(PREVIEW_TURN.slice(i, i + size)));
      }
      expect(events, `chunks of ${size}`).toEqual(whole);
    }
  });

  test('reads \\r\\n and \\r line ends, even with a \\r\\n split across chunks', () => {
    const crlf = PREVIEW_TURN.replaceAll('\n', '\r\n');
    const whole = eventParser().push(PREVIEW_TURN);
    expect(eventParser().push(crlf)).toEqual(whole);
    expect(eventParser().push(PREVIEW_TURN.replaceAll('\n', '\r'), true)).toEqual(whole);
    // Until the stream ends, a last \r may be half of a \r\n.
    expect(eventParser().push(PREVIEW_TURN.replaceAll('\n', '\r'))).toEqual(whole.slice(0, -1));
    const parser = eventParser();
    const cut = crlf.indexOf('\r\n') + 1;
    expect([...parser.push(crlf.slice(0, cut)), ...parser.push(crlf.slice(cut))]).toEqual(whole);
  });

  test('gives an event only at the blank line after it, and drops one left unfinished', () => {
    const parser = eventParser();
    expect(parser.push('event: text\ndata: {"delta":"Hi"}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ type: 'text', delta: 'Hi' }]);
    expect(parser.push('event: text\ndata: {"delta":"never finished"}')).toEqual([]);
  });

  test('takes "data:" with or without the space, and joins several data lines', () => {
    const events = eventParser().push(
      'event:text\ndata:{"delta":"a"}\n\nevent: text\ndata: {"delta":\ndata: "b"}\n\n',
    );
    expect(events).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'b' },
    ]);
  });

  test('skips events it does not know, and data that is not what its type carries', () => {
    const events = eventParser().push(
      [
        'event: progress\ndata: {"percent":50}\n',
        'event: text\ndata: not json\n',
        'event: step\ndata: {"id":"s1","tool":"preview_plan","label":"x","state":"thinking"}\n',
        'event: call\ndata: {"call":{"name":"undo"}}\n',
        'data: {"delta":"no type"}\n',
        'event: text\n',
        'event: text\ndata: {"delta":"kept"}\n',
        '',
      ].join('\n'),
    );
    expect(events).toEqual([{ type: 'text', delta: 'kept' }]);
  });

  test('reads an error, with and without when to try again', () => {
    expect(eventFrom('error', '{"message":"Busy","retryable":true,"retryAfterMs":120000}')).toEqual(
      { type: 'error', message: 'Busy', retryable: true, retryAfterMs: 120000 },
    );
    expect(eventFrom('error', '{"message":"No","retryable":false}')).toEqual({
      type: 'error',
      message: 'No',
      retryable: false,
    });
    expect(eventFrom('error', '{"message":"Busy","retryable":true,"retryAfterMs":-1}')).toBeNull();
  });
});
