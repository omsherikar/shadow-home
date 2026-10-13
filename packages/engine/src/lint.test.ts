import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan, PlanAction, PlanContext } from '@shadow-home/twin';
import { loadHome, loadPlan } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { checkOverrides, lint } from './lint.ts';

const root = join(import.meta.dirname, '../../..');
const home = loadHome(join(root, 'fixtures/demo-home.json'));
const NOW = '2027-01-15T17:45:00-06:00';

function plan(actions: PlanAction[], context: Partial<PlanContext> = {}): Plan {
  return { context: { now: NOW, ...context }, actions };
}

function codes(p: Plan) {
  return lint(home, p).findings.map((f) => f.code);
}

describe('lint passes valid plans', () => {
  test('an empty plan', () => {
    expect(lint(home, plan([]))).toEqual({ ok: true, findings: [] });
  });

  test('in-range writes, a group, a routine pause and a mode change', () => {
    const result = lint(
      home,
      plan(
        [
          { device: 'light_living', set: { onOff: true, brightness: 30 } },
          { device: 'thermostat_main', set: { heatingSetpointC: 21.5 } },
          { group: 'indoor_lights', set: { onOff: false }, at: '2027-01-15T23:00:00-06:00' },
          { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
          { mode: 'away' },
          { device: 'front_door_lock', set: { lockState: 'LOCKED' } },
        ],
        { planEnd: '2027-01-17T18:00:00-06:00' },
      ),
    );
    expect(result).toEqual({ ok: true, findings: [] });
  });

  test('an action exactly at now', () => {
    expect(codes(plan([{ device: 'plug_tv', set: { onOff: false }, at: NOW }]))).toEqual([]);
  });
});

describe('lint rejects', () => {
  test.each<[string, PlanAction, string]>([
    ['a device the home lacks', { device: 'sauna', set: { onOff: true } }, 'unknown_device'],
    ['a group the home lacks', { group: 'all_fans', set: { onOff: false } }, 'unknown_group'],
    [
      'a routine the home lacks',
      { routine: 'tea_at_4', pauseUntil: '2027-01-16T18:00:00-06:00' },
      'unknown_routine',
    ],
    ['a mode the home lacks', { mode: 'vacation' }, 'unknown_mode'],
    [
      'an attribute the device has no capability for',
      { device: 'light_kitchen', set: { brightness: 40 } },
      'unsupported_attribute',
    ],
    [
      'a read-only attribute',
      { device: 'thermostat_main', set: { localTemperatureC: 25 } },
      'unsupported_attribute',
    ],
    [
      'a write to a sensor',
      { device: 'window_bedroom_main', set: { contact: 'open' } },
      'unsupported_attribute',
    ],
    [
      'a value out of range',
      { device: 'thermostat_main', set: { heatingSetpointC: 45 } },
      'out_of_range',
    ],
    [
      'a value off the step',
      { device: 'thermostat_main', set: { heatingSetpointC: 21.3 } },
      'off_step',
    ],
    ['a value of the wrong type', { device: 'plug_tv', set: { onOff: 'off' } }, 'wrong_type'],
    [
      'a value outside an enum',
      { device: 'front_door_lock', set: { lockState: 'OPEN' } },
      'not_in_enum',
    ],
    [
      'a time before now',
      { device: 'plug_tv', set: { onOff: false }, at: '2027-01-15T17:44:00-06:00' },
      'time_in_past',
    ],
    [
      'a routine pause that has already ended',
      { routine: 'coffee_at_7', pauseUntil: NOW },
      'pause_in_past',
    ],
  ])('%s', (_name, action, code) => {
    const result = lint(home, plan([action]));
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual([code]);
    expect(result.findings[0]).toMatchObject({ stage: 'lint', kind: 'invalid', actionIndex: 0 });
  });

  test('a read-only attribute says so', () => {
    const [f] = lint(
      home,
      plan([{ device: 'thermostat_main', set: { localTemperatureC: 25 } }]),
    ).findings;
    expect(f?.message).toMatch(/read-only/);
  });

  test('a group write that some members cannot take names each of them', () => {
    const result = lint(home, plan([{ group: 'all_lights', set: { brightness: 30 } }]));
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.code, f.device])).toEqual([
      ['unsupported_attribute', 'light_kitchen'],
      ['unsupported_attribute', 'light_bedroom_sam'],
      ['unsupported_attribute', 'light_porch'],
    ]);
    expect(result.findings[0]?.message).toMatch(/all_lights/);
  });

  test('a plan end before now', () => {
    expect(codes(plan([], { planEnd: '2027-01-15T12:00:00-06:00' }))).toEqual(['plan_end_in_past']);
  });

  test('a presence window that ends before it starts', () => {
    const presenceSchedule = [
      {
        from: '2027-01-16T18:00:00-06:00',
        to: '2027-01-16T08:00:00-06:00',
        presence: 'nobody' as const,
      },
    ];
    expect(codes(plan([], { presenceSchedule }))).toEqual(['presence_window_reversed']);
  });

  test('a presence window naming someone outside the household', () => {
    const presenceSchedule = [
      {
        from: '2027-01-16T08:00:00-06:00',
        to: '2027-01-16T18:00:00-06:00',
        presence: { home: ['sam', 'zoe'] },
      },
    ];
    const result = lint(home, plan([], { presenceSchedule }));
    expect(result.findings.map((f) => f.code)).toEqual(['unknown_member']);
    expect(result.findings[0]?.actionIndex).toBeNull();
  });

  test('every problem in a plan, in action order', () => {
    const result = lint(
      home,
      plan([
        { device: 'plug_tv', set: { onOff: false } },
        { device: 'sauna', set: { onOff: true } },
        { device: 'thermostat_main', set: { heatingSetpointC: 3, systemMode: 'cool' } },
      ]),
    );
    expect(result.findings.map((f) => [f.actionIndex, f.code, f.attr ?? null])).toEqual([
      [1, 'unknown_device', null],
      [2, 'out_of_range', 'heatingSetpointC'],
      [2, 'not_in_enum', 'systemMode'],
    ]);
  });

  // Found by the property tests: names inherited from Object.prototype must not count as
  // groups, devices, capabilities or state.
  test.each<[string, PlanAction, string]>([
    ['a group called toString', { group: 'toString', set: { onOff: false } }, 'unknown_group'],
    [
      'a device called constructor',
      { device: 'constructor', set: { onOff: true } },
      'unknown_device',
    ],
    [
      'an attribute called constructor',
      { device: 'plug_tv', set: { constructor: 1 } },
      'unsupported_attribute',
    ],
    [
      'an attribute called toString',
      { device: 'plug_tv', set: { toString: true } },
      'unsupported_attribute',
    ],
    [
      'a routine called hasOwnProperty',
      { routine: 'hasOwnProperty', pauseUntil: '2027-01-16T08:00:00-06:00' },
      'unknown_routine',
    ],
  ])('%s', (_name, action, code) => {
    expect(codes(plan([action]))).toEqual([code]);
  });

  test('an inherited attribute name is not reported as read-only', () => {
    const [f] = lint(home, plan([{ device: 'plug_tv', set: { toString: true } }])).findings;
    expect(f?.message).not.toMatch(/read-only/);
  });
});

describe('lint: overlapping presence windows', () => {
  const w = (from: string, to: string, presence: 'nobody' | 'everyone') => ({
    from: `2027-01-16T${from}:00-06:00`,
    to: `2027-01-16T${to}:00-06:00`,
    presence,
  });

  test('overlapping windows that disagree are invalid', () => {
    const presenceSchedule = [w('18:00', '20:00', 'nobody'), w('19:00', '21:00', 'everyone')];
    expect(codes(plan([], { presenceSchedule }))).toEqual(['presence_windows_overlap']);
  });

  test('overlapping windows that agree, and back-to-back windows, are fine', () => {
    expect(
      codes(
        plan([], {
          presenceSchedule: [w('18:00', '20:00', 'nobody'), w('19:00', '21:00', 'nobody')],
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        plan([], {
          presenceSchedule: [w('18:00', '20:00', 'nobody'), w('20:00', '21:00', 'everyone')],
        }),
      ),
    ).toEqual([]);
  });
});

describe('checkOverrides (bench scaffolding, not plan content)', () => {
  test('accepts overrides on real devices and attributes', () => {
    const p = plan([], {
      stateOverrides: {
        dishwasher_latch: { sensor: { batteryPercent: 4 }, state: { contact: 'open' } },
      },
    });
    expect(checkOverrides(home, p)).toEqual([]);
  });

  test('names a sensor override on a device that has no sensor', () => {
    const p = plan([], {
      stateOverrides: { plug_garage_freezer: { sensor: { lastReportMinutesAgo: 120 } } },
    });
    expect(checkOverrides(home, p)).toEqual([
      'override sets a sensor on plug_garage_freezer, which has none',
    ]);
  });

  test('names unknown devices and attributes', () => {
    const p = plan([], {
      stateOverrides: {
        sauna: { state: { onOff: true } },
        plug_tv: { state: { brightness: 10 } },
        thermostat_main: { state: { heatingSetpointC: 99 } },
        window_bedroom_main: { state: { contact: 'ajar' } },
      },
    });
    expect(checkOverrides(home, p)).toEqual([
      'override for unknown device sauna',
      'override sets plug_tv.brightness, which it does not have',
      'override sets thermostat_main.heatingSetpointC: 99 is outside 7 to 30',
      'override sets window_bedroom_main.contact: expected one of open, closed, got "ajar"',
    ]);
  });
});

// Every invalid ShadowBench plan must fail lint, and every other plan must pass it.
describe('ShadowBench plans', () => {
  const dir = join(root, 'bench/plans');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  test.each(files)('%s', (file) => {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { set: string };
    const p = loadPlan(join(dir, file));
    expect(checkOverrides(home, p)).toEqual([]);
    const result = lint(home, p);
    if (raw.set === 'invalid') {
      expect(result.ok, `${file} should fail lint`).toBe(false);
    } else {
      expect(result.findings, `${file} should pass lint`).toEqual([]);
    }
  });

  test('P004 and P005 fail for the reason their notes give', () => {
    expect(codes(loadPlan(join(dir, 'P004.json')))).toEqual(['out_of_range']);
    expect(codes(loadPlan(join(dir, 'P005.json')))).toEqual(['unknown_device']);
  });
});
