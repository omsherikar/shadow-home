import { describe, expect, test } from 'vitest';
import { numbersIn, timesIn } from './guard.ts';

describe('times and numbers as people say them', () => {
  test('times on the 24-hour clock', () => {
    const keys = (t: string) => timesIn(t).times;
    expect(keys('at 9pm, 9 p.m. or 10:37 PM')).toEqual([['21:0'], ['21:0'], ['22:37']]);
    expect(keys('ten thirty-seven PM, seven oh five am')).toEqual([['22:37'], ['7:5']]);
    expect(keys('noon, midnight, 22:30, 07:00, 10:30')).toEqual([
      ['22:30'],
      ['7:0'],
      ['10:30', '22:30'],
      ['12:0'],
      ['0:0'],
    ]);
    expect(keys('37 pm')).toEqual([[]]);
  });

  test('numbers in digits and words, not in names', () => {
    expect(numbersIn('4.5 °C, twenty-five, four, 1,500, a dozen, the third')).toEqual([
      4.5, 1500, 25, 4, 12, 3,
    ]);
    expect(numbersIn('no one, the one that, first, rule R3, plan p1')).toEqual([]);
  });
});
