import { describe, expect, test } from 'vitest';
import { eventFrom, eventParser } from './stream.ts';

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
