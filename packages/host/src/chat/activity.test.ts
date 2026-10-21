import { describe, expect, test } from 'vitest';
import { shownActivity } from './activity.ts';

describe('what the chat shows Alexa doing', () => {
  test('her voice shows once the turn is over, for as long as it lasts', () => {
    expect(shownActivity('idle', true)).toBe('speaking');
    expect(shownActivity('idle', false)).toBe('idle');
  });

  test('a turn under way shows its own state, even while she speaks its first sentences', () => {
    expect(shownActivity('answering', true)).toBe('answering');
    expect(shownActivity('working', true)).toBe('working');
    expect(shownActivity('thinking', false)).toBe('thinking');
  });

  test('a mic tap while she speaks: listening, never overwritten by speaking', () => {
    // Speaking, then the tap: the voice stops and the mic listens, in either order.
    expect(shownActivity('idle', true)).toBe('speaking');
    expect(shownActivity('listening', true)).toBe('listening');
    expect(shownActivity('listening', false)).toBe('listening');
  });
});
