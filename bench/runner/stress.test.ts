import { join } from 'node:path';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { mismatchedHome } from './stress.ts';

const home = loadHome(join(import.meta.dirname, '../../fixtures/demo-home.json'));
const house = (h: typeof home) => h.zones.find((z) => z.id === 'house');

describe('a real house that differs from its twin', () => {
  test('colder: heat leaks faster, zones hold less, heaters and appliances give less', () => {
    const h = mismatchedHome(home, 'colder');
    expect(house(h)?.uaOutWPerK).toBeCloseTo(300 * 1.2);
    expect(house(h)?.heatCapacityJPerK).toBeCloseTo(12_000_000 * 0.8);
    expect(house(h)?.heater.maxPowerW).toBeCloseTo(12_000 * 0.8);
    expect(h.couplings[0]?.uaWPerK).toBeCloseTo(10 * 1.2);
    expect(h.internalGains[0]?.wattsWhenOn).toBeCloseTo(40 * 0.8);
  });

  test('warmer is the opposite, and the twin itself is left as it was', () => {
    const h = mismatchedHome(home, 'warmer');
    expect(house(h)?.uaOutWPerK).toBeCloseTo(300 * 0.8);
    expect(house(h)?.heater.maxPowerW).toBeCloseTo(12_000 * 1.2);
    expect(house(home)?.uaOutWPerK).toBe(300);
    expect(h.rules).toEqual(home.rules);
    expect(h.forecast).toEqual(home.forecast);
  });
});
