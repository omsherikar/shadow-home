import { join } from 'node:path';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { needsReversal } from './hygiene.ts';
import {
  clockMinutes,
  floorToMinute,
  formatClock,
  localMinuteOfDay,
  offsetMinutes,
  toMs,
} from './time.ts';
import { expandWrites } from './writes.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const NOW = '2027-01-15T17:45:00-06:00';

describe('time', () => {
  test('toMs reads the offset', () => {
    expect(toMs('2027-01-15T17:45:00-06:00')).toBe(toMs('2027-01-15T23:45:00Z'));
    expect(() => toMs('soon')).toThrow(/not a date-time/);
  });

  test('offsetMinutes', () => {
    expect(offsetMinutes('-06:00')).toBe(-360);
    expect(offsetMinutes('+05:30')).toBe(330);
    expect(() => offsetMinutes('CST')).toThrow(/not a UTC offset/);
  });

  test('localMinuteOfDay wraps across midnight in the home offset', () => {
    expect(localMinuteOfDay(toMs(NOW), -360)).toBe(17 * 60 + 45);
    expect(localMinuteOfDay(toMs('2027-01-16T00:10:00-06:00'), -360)).toBe(10);
    expect(localMinuteOfDay(toMs('2027-01-15T23:59:00-06:00'), -360)).toBe(1439);
  });

  test('floorToMinute drops seconds and milliseconds', () => {
    expect(floorToMinute(toMs('2027-01-15T20:00:59.999-06:00'))).toBe(
      toMs('2027-01-15T20:00:00-06:00'),
    );
    expect(floorToMinute(toMs('2027-01-15T20:00:00-06:00'))).toBe(
      toMs('2027-01-15T20:00:00-06:00'),
    );
  });

  test('clockMinutes and formatClock round-trip', () => {
    expect(clockMinutes('22:30')).toBe(1350);
    expect(formatClock(1350)).toBe('22:30');
    expect(formatClock(5)).toBe('00:05');
  });
});

describe('expandWrites', () => {
  test('expands groups, resolves times and skips unknown targets', () => {
    const writes = expandWrites(home, {
      context: { now: NOW },
      actions: [
        { group: 'indoor_lights', set: { onOff: false } },
        {
          device: 'thermostat_main',
          set: { heatingSetpointC: 18 },
          at: '2027-01-15T22:00:00-06:00',
        },
        { device: 'sauna', set: { onOff: true } },
        { group: 'all_fans', set: { onOff: true } },
        { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
        { mode: 'away' },
      ],
    });
    expect(writes.map((w) => [w.actionIndex, w.device, w.attr, w.value, w.group ?? null])).toEqual([
      [0, 'light_living', 'onOff', false, 'indoor_lights'],
      [0, 'light_kitchen', 'onOff', false, 'indoor_lights'],
      [0, 'light_bedroom_main', 'onOff', false, 'indoor_lights'],
      [0, 'light_bedroom_sam', 'onOff', false, 'indoor_lights'],
      [1, 'thermostat_main', 'heatingSetpointC', 18, null],
    ]);
    expect(writes[0]?.atMs).toBe(toMs(NOW));
    expect(writes[4]?.atMs).toBe(toMs('2027-01-15T22:00:00-06:00'));
  });
});

describe('needsReversal', () => {
  const device = (id: string) => {
    const d = home.devices.find((x) => x.id === id);
    if (!d) throw new Error(id);
    return d;
  };

  test.each([
    ['front_door_lock', 'lockState', 'UNLOCKED', true],
    ['front_door_lock', 'lockState', 'LOCKED', false],
    ['plug_bedroom_space_heater', 'onOff', true, true],
    ['plug_coffee_maker', 'onOff', true, true],
    ['plug_bedroom_space_heater', 'onOff', false, false],
    ['plug_tv', 'onOff', true, false],
    ['thermostat_main', 'heatingSetpointC', 30, false],
  ] as const)('%s.%s = %s → %s', (id, attr, value, expected) => {
    expect(needsReversal(device(id), attr, value)).toBe(expected);
  });
});
