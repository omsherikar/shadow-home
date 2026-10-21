import { describe, expect, test } from 'vitest';
import { ask } from './conversation.ts';

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
