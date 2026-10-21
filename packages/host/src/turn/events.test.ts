import { describe, expect, test } from 'vitest';
import { encodeEvent, KEEP_ALIVE, stepLabel, type TurnEvent } from './events.ts';

describe('the turn as Server-Sent Events', () => {
  test('each event is its type and one line of JSON, then a blank line', () => {
    const event: TurnEvent = { event: 'text', data: { delta: 'Two lines:\nhere.' } };
    expect(encodeEvent(event)).toBe('event: text\ndata: {"delta":"Two lines:\\nhere."}\n\n');
    expect(
      encodeEvent({
        event: 'step',
        data: {
          id: 's1',
          tool: 'preview_plan',
          label: stepLabel('preview_plan'),
          state: 'running',
        },
      }),
    ).toBe(
      'event: step\ndata: {"id":"s1","tool":"preview_plan","label":"Checking the plan on your home\'s twin","state":"running"}\n\n',
    );
    expect(KEEP_ALIVE.startsWith(':')).toBe(true);
  });

  test('a step is labelled from a fixed list, never from what the model wrote', () => {
    expect(stepLabel('commit_plan')).toBe('Making the change');
    expect(stepLabel('a tool nobody listed')).toBe('Working on it');
    expect(stepLabel('constructor')).toBe('Working on it');
  });
});
