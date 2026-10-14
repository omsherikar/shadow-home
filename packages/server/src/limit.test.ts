import { join } from 'node:path';
import { loadHome } from '@shadow-home/twin/node';
import { afterEach, describe, expect, test } from 'vitest';
import { capped } from './compiler.ts';
import { hourlyLimit, perHour } from './limit.ts';

const HOUR = 60 * 60 * 1000;

describe('an hourly allowance', () => {
  test('allows up to the limit in any rolling hour, and again as the oldest use ages out', () => {
    let t = 0;
    const allow = hourlyLimit(2, () => t);
    expect(allow()).toBe(true);
    t = 10 * 60 * 1000;
    expect([allow(), allow()]).toEqual([true, false]);
    t = HOUR - 1;
    expect(allow()).toBe(false);
    t = HOUR;
    // The first use has left the window, the second hasn't: one more fits. Refusals never counted.
    expect([allow(), allow()]).toEqual([true, false]);
  });

  test('zero allows nothing', () => {
    expect(hourlyLimit(0, () => 0)()).toBe(false);
  });

  afterEach(() => {
    delete process.env.TEST_PER_HOUR;
  });

  test('read from the environment as a whole number, else the default', () => {
    expect(perHour('TEST_PER_HOUR', 10)).toBe(10);
    for (const [raw, n] of [
      ['3', 3],
      ['0', 0],
      ['', 10],
      ['2.5', 10],
      ['-1', 10],
      ['lots', 10],
    ] as const) {
      process.env.TEST_PER_HOUR = raw;
      expect(perHour('TEST_PER_HOUR', 10)).toBe(n);
    }
  });
});

describe('a capped rule compiler', () => {
  const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
  const input = { text: 'Porch light off at night', author: 'om', home };

  test('past the allowance it fails without calling any model', async () => {
    let calls = 0;
    const compile = capped(
      async () => {
        calls += 1;
        return { status: 'unsupported', reason: 'stand-in' };
      },
      hourlyLimit(1, () => 0),
    );
    expect(await compile(input)).toEqual({ status: 'unsupported', reason: 'stand-in' });
    expect(await compile(input)).toMatchObject({ status: 'failed' });
    expect(calls).toBe(1);
  });
});
