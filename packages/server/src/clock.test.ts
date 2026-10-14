import { describe, expect, test } from 'vitest';
import { dailyClock } from './clock.ts';

describe('the deployed home', () => {
  const start = Date.parse('2027-01-15T17:45:00-06:00');

  test('starts over from the fixture once a day, and every instance agrees on its time', () => {
    let wall = Date.parse('2026-10-19T08:00:00Z');
    const one = dailyClock(start, 8, () => wall);
    const two = dailyClock(start, 8, () => wall);
    expect(one.homeNowMs()).toBe(start);
    expect(one.run()).toBe('2026-10-19');
    wall += 90 * 60_000;
    expect(one.homeNowMs()).toBe(start + 90 * 60_000);
    expect(two.homeNowMs()).toBe(one.homeNowMs());
    // Just before the restart it is nearly a day on; at the restart, a new home.
    wall = Date.parse('2026-10-20T07:59:59Z');
    expect(one.homeNowMs()).toBe(start + 24 * 60 * 60_000 - 1000);
    expect(one.run()).toBe('2026-10-19');
    wall = Date.parse('2026-10-20T08:00:00Z');
    expect(one.homeNowMs()).toBe(start);
    expect(one.run()).toBe('2026-10-20');
  });

  test('before the restart hour, the home that started the day before is still running', () => {
    const wall = Date.parse('2026-10-19T03:00:00Z');
    const clock = dailyClock(start, 8, () => wall);
    expect(clock.run()).toBe('2026-10-18');
    expect(clock.homeNowMs()).toBe(start + 19 * 60 * 60_000);
  });
});
