import { describe, expect, test } from 'vitest';
import type { ToolCall } from '../turn/types.ts';
import { ask, detailsFor } from './conversation.ts';

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

describe('an answer as it streams', () => {
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
