import { describe, expect, test } from 'vitest';
import { numbersIn } from './guard.ts';

describe('times and numbers as people say them', () => {
  test('numbers in digits and words, not in names', () => {
    expect(numbersIn('4.5 °C, twenty-five, four, 1,500, a dozen, the third')).toEqual([
      4.5, 1500, 25, 4, 12, 3,
    ]);
    expect(numbersIn('no one, the one that, first, rule R3, plan p1')).toEqual([]);
  });
});
