import { describe, expect, test } from 'vitest';
import { shownActivity } from './activity.ts';

describe('what the chat shows Alexa doing', () => {
  test('her voice shows once the turn is over, for as long as it lasts', () => {
    expect(shownActivity('idle', true)).toBe('speaking');
    expect(shownActivity('idle', false)).toBe('idle');
  });
});
