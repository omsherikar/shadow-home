import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { hourlyBudget, hourlyLimit } from './limit.ts';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

test('live turns and speech: at most the limit in any rolling hour, then room as uses age out', () => {
  let t = 0;
  const allow = hourlyLimit(2, () => t);
  expect([allow(), allow(), allow()]).toEqual([true, true, false]);
  t = 60 * 60 * 1000;
  expect([allow(), allow(), allow()]).toEqual([true, true, false]);
});

test("the server's copy is the same file", () => {
  const copy = (pkg: string) =>
    readFileSync(join(import.meta.dirname, `../../${pkg}/src/limit.ts`), 'utf8');
  expect(copy('host')).toBe(copy('server'));
});

describe('an hourly budget', () => {
  test('spends amounts up to the budget in any rolling hour; a refused amount costs nothing', () => {
    let t = 0;
    const spend = hourlyBudget(100, () => t);
    expect(spend(60)).toBe(true);
    t = 10 * MINUTE;
    expect(spend(50)).toBe(false);
    expect(spend(40)).toBe(true);
    expect(spend()).toBe(false);
    // The 60 has left the window; the 40 hasn't.
    t = HOUR;
    expect(spend(60)).toBe(true);
    expect(spend(1)).toBe(false);
  });

  test('an amount larger than the whole budget is refused', () => {
    const spend = hourlyBudget(100, () => 0);
    expect(spend(101)).toBe(false);
    expect(spend(100)).toBe(true);
  });

  test('fits says whether an amount would be spent, and spends nothing', () => {
    const spend = hourlyBudget(10, () => 0);
    expect(spend.fits(10)).toBe(true);
    expect(spend.fits(10)).toBe(true);
    expect(spend(6)).toBe(true);
    expect([spend.fits(4), spend.fits(5), spend.fits()]).toEqual([true, false, true]);
    expect(spend(4)).toBe(true);
  });

  test('an amount that is not a positive number is refused, and adds nothing back', () => {
    const spend = hourlyBudget(10, () => 0);
    expect(spend(10)).toBe(true);
    for (const amount of [0, -5, Number.NaN]) expect(spend(amount)).toBe(false);
    expect(spend(1)).toBe(false);
  });
});
