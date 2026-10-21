import { describe, expect, test } from 'vitest';
import type { ToolCall } from '../turn/types.ts';
import {
  ask,
  clockAt,
  detailsFor,
  type Message,
  problemWords,
  stopped,
  withEvent,
} from './conversation.ts';

const call = (name: string, structuredContent: Record<string, unknown>, isError = false) =>
  ({ name, arguments: {}, result: { content: [], structuredContent, isError } }) as ToolCall;

const preview = (extra: Record<string, unknown>) => ({
  planId: 'p1',
  kind: 'plan',
  verdict: 'UNSAFE',
  tier: 'T3',
  diff: [{ target: 'plug_tv' }],
  violations: [],
  ...extra,
});

const WEEKEND = call(
  'preview_plan',
  preview({
    repair: { planId: 'p2', verdict: 'SAFE' },
    violations: [
      {
        rule: 'R3',
        text: "Don't let the garage pipes freeze.",
        author: 'om',
        priority: 'safety',
      },
    ],
  }),
);

describe('an answer as it streams', () => {
  const start = (): Message => {
    const [, alexa] = ask([], 't1', "I'm away for the weekend", {
      text: "I'm away for the weekend",
      history: [],
    });
    if (!alexa) throw new Error('no answer');
    return alexa;
  };

  test('starts thinking, keeping the exact request to retry', () => {
    const request = {
      text: 'Yes.',
      history: [{ name: 'preview_plan', arguments: {}, structuredContent: { planId: 'p1' } }],
      screen: 'On screen, the person tapped “Why”.',
    };
    const messages = ask([], 't1', 'Run the safer plan', request);
    expect(messages).toEqual([
      { id: 't1-you', who: 'you', text: 'Run the safer plan' },
      { id: 't1-alexa', who: 'alexa', text: '', phase: 'thinking', steps: [], request },
    ]);
  });

  test('words add up as they arrive; a step shows working, then done in place', () => {
    let m = withEvent(start(), { type: 'text', delta: 'Let me ' }, 0);
    m = withEvent(m, { type: 'text', delta: 'check.' }, 0);
    expect(m).toMatchObject({ text: 'Let me check.', phase: 'talking' });
    const step = { type: 'step', id: 's1', tool: 'preview_plan', label: 'Checking' } as const;
    m = withEvent(m, { ...step, state: 'running' }, 0);
    expect(m.phase).toBe('working');
    expect(m.steps).toEqual([{ id: 's1', label: 'Checking', state: 'running' }]);
    m = withEvent(m, { ...step, state: 'done' }, 0);
    expect(m.steps).toEqual([{ id: 's1', label: 'Checking', state: 'done' }]);
  });

  test('a call puts its verdict and details on the answer before it finishes', () => {
    const m = withEvent(start(), { type: 'call', call: WEEKEND }, 0);
    expect(m.verdict).toBe('UNSAFE');
    expect(m.details).toEqual([
      "R3: “Don't let the garage pipes freeze.” Om’s rule, safety priority.",
    ]);
    expect(m.phase).toBe('thinking');
  });

  test('done replaces what streamed with what she says, and a commit makes it Done', () => {
    let m = withEvent(start(), { type: 'text', delta: 'It is safe, I think' }, 0);
    const commit = call('commit_plan', { status: 'committed', applied: [] });
    m = withEvent(m, { type: 'done', turn: { say: 'Done: 10 changes.', calls: [commit] } }, 0);
    expect(m).toMatchObject({ text: 'Done: 10 changes.', phase: 'done', verdict: 'DONE' });
  });

  test('an error keeps when to come back, from the time it arrived', () => {
    const m = withEvent(
      start(),
      { type: 'error', message: 'Too many requests.', retryable: true, retryAfterMs: 60_000 },
      1_000,
    );
    expect(m).toMatchObject({ phase: 'failed' });
    expect(m.problem).toEqual({ message: 'Too many requests.', retryable: true, retryAt: 61_000 });
  });

  test('stopped keeps what came, and a step still running no longer is', () => {
    let m = withEvent(start(), { type: 'text', delta: 'Checking' }, 0);
    m = withEvent(
      m,
      { type: 'step', id: 's1', tool: 'preview_plan', label: 'Checking', state: 'running' },
      0,
    );
    expect(stopped(m)).toMatchObject({
      text: 'Checking',
      phase: 'stopped',
      steps: [{ id: 's1', state: 'failed' }],
    });
  });
});

describe('the words for a problem', () => {
  test('a limit says the time to come back, in the time zone given', () => {
    const at = Date.UTC(2026, 9, 21, 22, 40);
    expect(clockAt(at, 'America/Los_Angeles')).toBe('3:40 PM');
    expect(
      problemWords(
        {
          message: "I've had a lot of requests this hour. Try again later.",
          retryable: true,
          retryAt: at,
        },
        'America/Los_Angeles',
      ),
    ).toBe("I've had a lot of requests this hour. Try again at 3:40 PM.");
  });
});

describe('the details view', () => {
  test("a new rule's clash says which wins by priority", () => {
    const rule = call('add_house_rule', {
      conflicts: [
        {
          rule: 'R6',
          text: 'Unlock the doors when the smoke alarm goes off.',
          priority: 'safety',
          winner: 'R6',
        },
      ],
    });
    expect(detailsFor(rule)).toEqual([
      'Clashes with R6: “Unlock the doors when the smoke alarm goes off.” (safety priority). R6 wins by priority.',
    ]);
  });

  test("whose rule uses the household's names when the server sent them", () => {
    const names = { devices: {}, routines: {}, members: { om: 'Om', maya: 'Maya' } };
    const v = {
      rule: 'R2',
      text: 'Keep the aquarium heater on.',
      author: 'maya',
      priority: 'comfort',
    };
    expect(detailsFor(call('preview_plan', preview({ violations: [v] })), names)).toEqual([
      'R2: “Keep the aquarium heater on.” Maya’s rule, comfort priority.',
    ]);
  });
});
