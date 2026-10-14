import type { Home } from '@shadow-home/twin';

export type Mismatch = 'colder' | 'warmer';

/**
 * The home with its physics off by `by` (0.2 is 20%) in one coherent direction, standing in for a
 * real house that differs from its twin. Colder: heat leaks out and between zones faster, zones
 * hold less of it, and heaters and appliances give less. Warmer: the opposite. Nothing else
 * changes: devices, routines, rules, the forecast.
 */
export function mismatchedHome(home: Home, direction: Mismatch, by = 0.2): Home {
  const more = 1 + by;
  const less = 1 - by;
  const [leak, hold, give] = direction === 'colder' ? [more, less, less] : [less, more, more];
  const out = structuredClone(home);
  for (const zone of out.zones) {
    zone.uaOutWPerK *= leak;
    zone.heatCapacityJPerK *= hold;
    zone.heater.maxPowerW *= give;
  }
  for (const c of out.couplings) c.uaWPerK *= leak;
  for (const g of out.internalGains) g.wattsWhenOn *= give;
  return out;
}
