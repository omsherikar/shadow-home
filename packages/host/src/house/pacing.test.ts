import { describe, expect, test } from 'vitest';
import { type Anchor, NEAR_EVENT, speedAt } from './pacing.ts';

const HOUR = 3_600_000;

describe('the clock’s speed', () => {
  const event: Anchor = { atMs: 10 * HOUR, ...NEAR_EVENT };

  test('is full far from anything, slowest at the moment itself, and eases between', () => {
    expect(speedAt([event], 0)).toBe(1);
    expect(speedAt([event], 10 * HOUR)).toBeCloseTo(NEAR_EVENT.speed, 9);
    const near = speedAt([event], 10 * HOUR + 20 * 60_000);
    const further = speedAt([event], 10 * HOUR + 60 * 60_000);
    expect(near).toBeGreaterThan(NEAR_EVENT.speed);
    expect(further).toBeGreaterThan(near);
    expect(further).toBeLessThan(1);
  });

  test('the slowest of two moments nearby wins', () => {
    const gentle: Anchor = { atMs: 10 * HOUR, reachMs: HOUR, speed: 0.5 };
    expect(speedAt([gentle, event], 10 * HOUR)).toBeCloseTo(NEAR_EVENT.speed, 9);
  });
});
