import { join } from 'node:path';
import type { Plan } from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { evalCond, type Frame } from './conditions.ts';
import { forecastAt } from './forecast.ts';
import { computeHorizon } from './horizon.ts';
import { and, not, or, type Truth } from './logic.ts';
import { formatIso, toMs } from './time.ts';
import { untrustedSensors } from './trust.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const t = (iso: string) => toMs(`${iso}-06:00`);
const plan = (p: Partial<Plan> & { now?: string } = {}): Plan => ({
  context: { now: '2027-01-15T17:45:00-06:00', ...p.context },
  actions: p.actions ?? [],
});

describe('three-valued logic', () => {
  const U = 'unknown' as const;
  test.each<[Truth[], Truth, Truth]>([
    [[true, true], true, true],
    [[true, false], false, true],
    [[false, U], false, U],
    [[true, U], U, true],
    [[U, U], U, U],
    [[], true, false],
  ])('and/or of %o', (xs, all, any) => {
    expect(and(...xs)).toBe(all);
    expect(or(...xs)).toBe(any);
  });

  test('not', () => {
    expect(not(true)).toBe(false);
    expect(not(false)).toBe(true);
    expect(not(U)).toBe(U);
  });
});

describe('forecastAt', () => {
  test('returns hourly points exactly and interpolates between them', () => {
    expect(forecastAt(home, t('2027-01-15T18:00:00'))).toBeCloseTo(2.0);
    expect(forecastAt(home, t('2027-01-15T19:30:00'))).toBeCloseTo(1.8);
    expect(forecastAt(home, t('2027-01-17T05:00:00'))).toBeCloseTo(-6.0);
  });

  test('applies the run offset', () => {
    expect(forecastAt(home, t('2027-01-17T05:00:00'), -2)).toBeCloseTo(-8.0);
  });

  test('is undefined outside the forecast', () => {
    expect(forecastAt(home, t('2027-01-15T16:59:00'))).toBeUndefined();
    expect(forecastAt(home, t('2027-01-19T00:01:00'))).toBeUndefined();
    expect(forecastAt(home, t('2027-01-19T00:00:00'))).toBeCloseTo(0.0);
  });
});

describe('untrustedSensors', () => {
  test('flags low battery in the fixture and nothing else', () => {
    expect(untrustedSensors(home, plan())).toEqual(
      new Map([['dishwasher_latch', 'dishwasher_latch: battery 4% is under 15%']]),
    );
  });

  test('applies plan overrides for staleness and battery', () => {
    const p = plan({
      context: {
        now: '2027-01-15T17:45:00-06:00',
        stateOverrides: {
          dishwasher_latch: { sensor: { batteryPercent: 80 } },
          window_bedroom_main: { sensor: { lastReportMinutesAgo: 38 } },
          front_door_lock: { sensor: { batteryPercent: 9, lastReportMinutesAgo: 30 } },
        },
      },
    });
    expect(untrustedSensors(home, p)).toEqual(
      new Map([
        ['window_bedroom_main', 'window_bedroom_main: silent for 38 minutes, over 10'],
        [
          'front_door_lock',
          'front_door_lock: battery 9% is under 15%; silent for 30 minutes, over 10',
        ],
      ]),
    );
  });

  test('exactly at the thresholds is still trusted', () => {
    const p = plan({
      context: {
        now: '2027-01-15T17:45:00-06:00',
        stateOverrides: {
          dishwasher_latch: { sensor: { batteryPercent: 15, lastReportMinutesAgo: 10 } },
        },
      },
    });
    expect(untrustedSensors(home, p).size).toBe(0);
  });
});

describe('evalCond', () => {
  const frame = (over: Partial<Frame> = {}): Frame => ({
    ms: t('2027-01-15T23:00:00'),
    localMinute: 23 * 60,
    devices: new Map(home.devices.map((d) => [d.id, { ...d.state }])),
    presence: { om: 'home', maya: 'home', sam: 'home' },
    zoneTempC: { house: 20, garage: 9 },
    ...over,
  });
  const none = new Map<string, string>();

  test('state conditions with eq and neq', () => {
    expect(evalCond({ device: 'plug_tv', attr: 'onOff', eq: true }, frame(), none)).toBe(true);
    expect(evalCond({ device: 'plug_tv', attr: 'onOff', neq: true }, frame(), none)).toBe(false);
  });

  test('a reading from an untrusted sensor is unknown', () => {
    const untrusted = new Map([['dishwasher_latch', 'low battery']]);
    const latchOpen = { device: 'dishwasher_latch', attr: 'contact', neq: 'closed' };
    expect(evalCond(latchOpen, frame(), untrusted)).toBe('unknown');
    // R11 with the dishwasher off: false whatever the latch says.
    const r11 = {
      all: [{ device: 'dishwasher', attr: 'onOff', eq: true }, latchOpen],
    };
    expect(evalCond(r11, frame(), untrusted)).toBe(false);
  });

  test('presence', () => {
    const away = frame({ presence: { om: 'away', maya: 'away', sam: 'away' } });
    const someone = frame({ presence: { om: 'away', maya: 'home', sam: 'away' } });
    expect(evalCond({ presence: 'nobody' }, away, none)).toBe(true);
    expect(evalCond({ presence: 'nobody' }, someone, none)).toBe(false);
    expect(evalCond({ presence: 'anyone' }, someone, none)).toBe(true);
    expect(evalCond({ presence: { member: 'om', is: 'home' } }, someone, none)).toBe(false);
    expect(evalCond({ presence: { member: 'maya', is: 'home' } }, someone, none)).toBe(true);
  });

  test('time windows, including ones that wrap past midnight', () => {
    const night = { time: { from: '22:00', to: '06:00' } };
    expect(evalCond(night, frame({ localMinute: 23 * 60 }), none)).toBe(true);
    expect(evalCond(night, frame({ localMinute: 5 * 60 + 59 }), none)).toBe(true);
    expect(evalCond(night, frame({ localMinute: 6 * 60 }), none)).toBe(false);
    expect(evalCond(night, frame({ localMinute: 12 * 60 }), none)).toBe(false);
    expect(
      evalCond({ time: { from: '09:00', to: '17:00' } }, frame({ localMinute: 600 }), none),
    ).toBe(true);
  });

  test('any, all and not', () => {
    const on = { device: 'plug_tv', attr: 'onOff', eq: true };
    const off = { device: 'plug_tv', attr: 'onOff', eq: false };
    expect(evalCond({ any: [off, on] }, frame(), none)).toBe(true);
    expect(evalCond({ all: [off, on] }, frame(), none)).toBe(false);
    expect(evalCond({ not: off }, frame(), none)).toBe(true);
  });
});

describe('computeHorizon', () => {
  test('runs to planEnd when it is later than 12 h after the last action', () => {
    const h = computeHorizon(
      home,
      plan({ context: { now: '2027-01-15T17:45:00-06:00', planEnd: '2027-01-17T18:00:00-06:00' } }),
    );
    expect(h).toEqual({
      startMs: t('2027-01-15T17:45:00'),
      endMs: t('2027-01-17T18:00:00'),
      unknowns: [],
    });
  });

  test('runs 12 h past the last action when there is no planEnd', () => {
    const h = computeHorizon(
      home,
      plan({
        context: { now: '2027-01-15T21:30:00-06:00' },
        actions: [{ device: 'dishwasher', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00' }],
      }),
    );
    expect(h.endMs).toBe(t('2027-01-16T14:00:00'));
    expect(h.unknowns).toEqual([]);
  });

  test('an empty plan runs 12 h from now', () => {
    expect(computeHorizon(home, plan()).endMs).toBe(t('2027-01-16T05:45:00'));
  });

  test('stops where the forecast ends and says so', () => {
    const h = computeHorizon(home, plan({ context: { now: '2027-01-18T20:00:00-06:00' } }));
    expect(h.endMs).toBe(t('2027-01-19T00:00:00'));
    expect(h.unknowns).toEqual(['no forecast after 2027-01-19T00:00:00-06:00']);
  });

  test('an action past the forecast is unknown', () => {
    const h = computeHorizon(
      home,
      plan({
        actions: [{ device: 'plug_tv', set: { onOff: false }, at: '2027-01-19T09:00:00-06:00' }],
      }),
    );
    expect(h.unknowns).toContain(
      'action 0 at 2027-01-19T09:00:00-06:00 is past the end of the simulation',
    );
  });

  test('caps at 72 hours, and says so', () => {
    // A forecast four days long, so the 72-hour cap binds before the forecast ends.
    const long = structuredClone(home);
    const last = toMs(long.forecast.hourly.at(-1)?.time ?? '');
    for (let i = 1; i <= 72; i++) {
      const at = formatIso(last + i * 3_600_000, -360);
      long.forecast.hourly.push({ time: at, tempC: 0 });
    }
    const h = computeHorizon(
      long,
      plan({ context: { now: '2027-01-15T17:00:00-06:00', planEnd: '2027-01-20T00:00:00-06:00' } }),
    );
    expect(h.endMs).toBe(t('2027-01-18T17:00:00'));
    expect(h.unknowns).toEqual([
      'the plan runs to 2027-01-20T00:00:00-06:00, past the 72-hour limit of the simulation',
    ]);
  });

  test('runs to the end of the last presence window, even without planEnd', () => {
    const h = computeHorizon(
      home,
      plan({
        context: {
          now: '2027-01-15T17:45:00-06:00',
          presenceSchedule: [
            {
              from: '2027-01-15T18:00:00-06:00',
              to: '2027-01-17T18:00:00-06:00',
              presence: 'nobody',
            },
          ],
        },
      }),
    );
    expect(h.endMs).toBe(t('2027-01-17T18:00:00'));
  });

  test('runs to the end of the latest routine pause', () => {
    const h = computeHorizon(
      home,
      plan({ actions: [{ routine: 'coffee_at_7', pauseUntil: '2027-01-17T12:00:00-06:00' }] }),
    );
    expect(h.endMs).toBe(t('2027-01-17T12:00:00'));
  });

  test('a now before the forecast starts is unknown', () => {
    const h = computeHorizon(home, plan({ context: { now: '2027-01-15T12:00:00-06:00' } }));
    expect(h.unknowns).toEqual(['no forecast before 2027-01-15T17:00:00-06:00']);
  });
});
