import { describe, expect, test } from 'vitest';
import { type Anchor, NEAR_EVENT, paceSlices, speedAt } from './pacing.ts';

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

describe('slices of a run’s clock', () => {
  const event: Anchor = { atMs: 12 * HOUR, ...NEAR_EVENT };
  const slices = paceSlices(0, 24 * HOUR, [event], 10_000);

  test('cover the run and add up to the time it should take', () => {
    expect(slices[0]?.fromMs).toBe(0);
    expect(slices.at(-1)?.toMs).toBe(24 * HOUR);
    const total = slices.reduce((sum, s) => sum + s.rate * (s.toMs - s.fromMs), 0);
    expect(total).toBeCloseTo(10_000, 6);
  });

  test('take longer near the moment than in the quiet hours', () => {
    const near = slices.find((s) => s.fromMs <= 12 * HOUR && 12 * HOUR < s.toMs);
    const quiet = slices[0];
    expect((near?.rate ?? 0) / (quiet?.rate ?? 1)).toBeGreaterThan(5);
  });

  test('a run of no length has nothing to slice', () => {
    expect(paceSlices(5, 5, [], 1000)).toEqual([]);
  });
});
