import { describe, expect, test } from 'vitest';
import { stepLabel } from './events.ts';

describe('the turn as Server-Sent Events', () => {
  test('a step is labelled from a fixed list, never from what the model wrote', () => {
    expect(stepLabel('commit_plan')).toBe('Making the change');
    expect(stepLabel('a tool nobody listed')).toBe('Working on it');
    expect(stepLabel('constructor')).toBe('Working on it');
  });
});
