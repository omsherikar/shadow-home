import { describe, expect, test } from 'vitest';
import { restartDelay } from './listener.ts';

describe('waiting before starting again', () => {
  test('soon after a normal end, then longer while it keeps failing, never past 5 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(restartDelay)).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000,
    ]);
  });
});
