import { join } from 'node:path';
import type { Plan, PlanAction } from '@shadow-home/twin';
import { loadHome, loadPlan } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { check } from './verdict.ts';

const root = join(import.meta.dirname, '../../..');
const home = loadHome(join(root, 'fixtures/demo-home.json'));
const bench = (id: string) => loadPlan(join(root, `bench/plans/${id}.json`));
const p001 = bench('P001');

function repaired(garageC: number): Plan {
  const actions: PlanAction[] = [
    { device: 'thermostat_main', set: { heatingSetpointC: 10 } },
    { device: 'garage_thermostat', set: { systemMode: 'heat', heatingSetpointC: garageC } },
    { device: 'plug_tv', set: { onOff: false } },
    { device: 'plug_coffee_maker', set: { onOff: false } },
    { device: 'plug_bedroom_space_heater', set: { onOff: false } },
    { group: 'all_lights', set: { onOff: false } },
    { device: 'front_door_lock', set: { lockState: 'LOCKED' } },
    { device: 'back_door_lock', set: { lockState: 'LOCKED' } },
    { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
    { mode: 'away' },
  ];
  return { context: p001.context, actions };
}

describe('the weekend away plan', () => {
  const result = check(home, p001);

  test('is UNSAFE, citing the freezer, the aquarium, Coffee at 7 and the garage pipes', () => {
    expect(result.verdict).toBe('UNSAFE');
    const cited = result.reasons.map((r) =>
      r.kind === 'violation' ? [r.rule, r.firstAt, r.cause?.source, r.cause?.device] : [r.kind],
    );
    expect(cited).toEqual([
      // Life safety first, then device protection; within a priority, earliest first.
      ['R8', '2027-01-16T07:00:00-06:00', 'coffee_at_7', 'plug_coffee_maker'],
      ['R1', '2027-01-15T17:45:00-06:00', 'plan', 'plug_garage_freezer'],
      ['R2', '2027-01-15T17:45:00-06:00', 'plan', 'plug_aquarium'],
      ['R3', '2027-01-16T22:37:00-06:00', 'plan', 'garage_thermostat'],
    ]);
  });

  test('each reason carries the rule, its author and priority, and the plan action involved', () => {
    expect(result.reasons[1]).toMatchObject({
      kind: 'violation',
      rule: 'R1',
      text: 'Never turn off the garage freezer.',
      author: 'om',
      priority: 'device-protection',
      run: 'nominal',
      cause: { source: 'plan', actionIndex: 2, attr: 'onOff', to: false },
    });
  });

  test('reports all three runs, with the garage minimum in each', () => {
    expect(result.runs?.nominal.zoneMinC.garage?.tempC).toBeCloseTo(0.27, 1);
    expect(result.runs?.pessimistic.zoneMinC.garage?.tempC).toBeCloseTo(-2.08, 1);
    expect(result.runs?.optimistic.zoneMinC.garage?.tempC).toBeCloseTo(2.64, 1);
    expect(result.runs?.pessimistic.violated).toEqual(['R1', 'R2', 'R3', 'R8']);
  });

  test('keeps the nominal timeline of changes, plan and routines together', () => {
    const coffee = result.timeline.filter((c) => c.source === 'coffee_at_7');
    expect(coffee.map((c) => [c.at, c.to])).toEqual([
      ['2027-01-16T07:00:00-06:00', true],
      ['2027-01-16T07:30:00-06:00', false],
      ['2027-01-17T07:00:00-06:00', true],
      ['2027-01-17T07:30:00-06:00', false],
    ]);
  });

  test('includes the lint and hygiene results', () => {
    expect(result.lint).toEqual({ ok: true, findings: [] });
    expect(result.hygiene).toEqual([]);
    expect(result.horizon).toEqual({
      start: '2027-01-15T17:45:00-06:00',
      end: '2027-01-17T18:00:00-06:00',
    });
  });
});

describe('the repaired weekend plan', () => {
  test('is SAFE with the garage heater at 5 °C', () => {
    const r = check(home, repaired(5));
    expect(r.verdict).toBe('SAFE');
    expect(r.reasons).toEqual([]);
    expect(r.unknowns).toEqual([]);
  });

  test('is UNSAFE at 4.5 °C: the heater only starts below 4.0 °C, so the garage dips under it', () => {
    const r = check(home, repaired(4.5));
    expect(r.verdict).toBe('UNSAFE');
    expect(r.reasons.map((x) => [x.kind, 'rule' in x ? x.rule : null])).toEqual([
      ['violation', 'R3'],
    ]);
    // fixtures/README.md: the pessimistic minimum is 3.99 °C.
    expect(r.runs?.pessimistic.zoneMinC.garage?.tempC).toBe(3.99);
  });
});

describe('other starter plans', () => {
  test('P002, dimming the living room, is SAFE', () => {
    const r = check(home, bench('P002'));
    expect(r.verdict).toBe('SAFE');
    expect(r.reasons).toEqual([]);
  });

  test('P003, the dishwasher at 2 AM, is UNPROVEN because the latch sensor is at 4 % battery', () => {
    const r = check(home, bench('P003'));
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.unknowns).toEqual(['dishwasher_latch: battery 4% is under 15%']);
    expect(r.reasons).toMatchObject([
      { kind: 'unknown', rule: 'R11', firstAt: '2027-01-16T02:00:00-06:00' },
    ]);
  });

  test.each(['P004', 'P005'])('%s is UNSAFE at lint, without simulating', (id) => {
    const r = check(home, bench(id));
    expect(r.verdict).toBe('UNSAFE');
    expect(r.reasons.every((x) => x.kind === 'invalid')).toBe(true);
    expect(r.runs).toBeUndefined();
  });
});

describe('verdict rules', () => {
  test('an away window without planEnd is simulated to its end, so Coffee at 7 is caught', () => {
    const r = check(home, {
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
      actions: [
        { group: 'indoor_lights', set: { onOff: false } },
        { device: 'front_door_lock', set: { lockState: 'LOCKED' } },
      ],
    });
    expect(r.verdict).toBe('UNSAFE');
    expect(r.reasons[0]).toMatchObject({
      kind: 'violation',
      rule: 'R8',
      cause: { source: 'coffee_at_7' },
    });
  });

  test('a forbidden state the plan commands is UNSAFE even when the device’s sensor is untrusted', () => {
    const r = check(home, {
      context: {
        now: '2027-01-15T17:45:00-06:00',
        stateOverrides: { smoke_alarm_kitchen: { sensor: { batteryPercent: 10 } } },
      },
      actions: [{ device: 'smoke_alarm_kitchen', set: { enabled: false } }],
    });
    expect(r.verdict).toBe('UNSAFE');
    expect(r.reasons[0]).toMatchObject({ kind: 'violation', rule: 'R12', refuse: true });
  });

  test('unlocking a low-battery lock with nobody home is UNSAFE', () => {
    const r = check(home, {
      context: {
        now: '2027-01-15T17:45:00-06:00',
        presenceSchedule: [
          {
            from: '2027-01-15T17:45:00-06:00',
            to: '2027-01-15T20:00:00-06:00',
            presence: 'nobody',
          },
        ],
        stateOverrides: {
          front_door_lock: { sensor: { batteryPercent: 9 } },
          light_living: { state: { onOff: false } },
          light_kitchen: { state: { onOff: false } },
          light_bedroom_sam: { state: { onOff: false } },
        },
      },
      actions: [{ device: 'front_door_lock', set: { lockState: 'UNLOCKED' } }],
    });
    expect(r.verdict).toBe('UNSAFE');
    expect(r.reasons.map((x) => [x.kind, 'rule' in x ? x.rule : null])).toEqual([
      ['violation', 'R4'],
    ]);
  });

  test('locking a low-battery lock with nobody home is UNPROVEN: the lock may not have engaged', () => {
    const r = check(home, {
      context: {
        now: '2027-01-15T17:45:00-06:00',
        presenceSchedule: [
          {
            from: '2027-01-15T17:45:00-06:00',
            to: '2027-01-15T20:00:00-06:00',
            presence: 'nobody',
          },
        ],
        stateOverrides: {
          front_door_lock: { sensor: { batteryPercent: 9 } },
          light_living: { state: { onOff: false } },
          light_kitchen: { state: { onOff: false } },
          light_bedroom_sam: { state: { onOff: false } },
        },
      },
      actions: [{ device: 'front_door_lock', set: { lockState: 'LOCKED' } }],
    });
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.unknowns).toEqual(['front_door_lock: battery 9% is under 15%']);
  });

  test('the cause is a change that moved toward the violation, never one away from it', () => {
    // Nobody home from 18:00. The plan turns one light off; the kitchen light and Sam's light
    // stay on, so R10 breaks at 18:00 because people left, not because of the plan's action.
    const r = check(home, {
      context: p001.context,
      actions: [
        { device: 'light_living', set: { onOff: false } },
        { device: 'front_door_lock', set: { lockState: 'LOCKED' } },
        { device: 'garage_thermostat', set: { heatingSetpointC: 9 } },
        { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
      ],
    });
    const r10 = r.reasons.find((x) => 'rule' in x && x.rule === 'R10');
    expect(r10).toMatchObject({ kind: 'violation', firstAt: '2027-01-15T18:00:00-06:00' });
    expect(r10 && 'cause' in r10 ? r10.cause : undefined).toBeUndefined();
  });

  test('a plan that holds in the nominal run but not the pessimistic one is UNPROVEN', () => {
    // Heater off, home again by Saturday noon. The nominal garage bottoms out at 4.83 °C; the
    // pessimistic one falls below 4 °C at Sat 03:51 (02:43 with the freezer off, as in the
    // reference run; the freezer's 40 W slows the cooling).
    const until = '2027-01-16T12:00:00-06:00';
    const plan: Plan = {
      context: {
        now: '2027-01-15T17:45:00-06:00',
        presenceSchedule: [{ from: '2027-01-15T18:00:00-06:00', to: until, presence: 'nobody' }],
        planEnd: until,
      },
      actions: [
        ...repaired(5).actions.filter(
          (a) => !('routine' in a) && !('device' in a && a.device === 'garage_thermostat'),
        ),
        { device: 'garage_thermostat', set: { systemMode: 'off' } },
        { routine: 'coffee_at_7', pauseUntil: until },
      ],
    };
    const r = check(home, plan);
    expect(r.verdict).toBe('UNPROVEN');
    expect(
      r.reasons.map((x) => [x.kind, 'rule' in x ? x.rule : null, 'run' in x ? x.run : null]),
    ).toEqual([['not_robust', 'R3', 'pessimistic']]);
    expect(r.reasons[0]).toMatchObject({ firstAt: '2027-01-16T03:51:00-06:00' });
    expect(r.runs?.nominal.zoneMinC.garage?.tempC).toBe(4.83);
  });

  test('turning off the smoke alarm breaks a refuse rule', () => {
    const r = check(home, {
      context: { now: '2027-01-15T17:45:00-06:00' },
      actions: [{ device: 'smoke_alarm_kitchen', set: { enabled: false } }],
    });
    expect(r.verdict).toBe('UNSAFE');
    expect(r.reasons).toMatchObject([{ kind: 'violation', rule: 'R12', refuse: true }]);
  });

  test('a plan the forecast does not cover is UNPROVEN, and says why', () => {
    const r = check(home, { context: { now: '2027-01-17T20:00:00-06:00' }, actions: [] });
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.unknowns).toEqual(['no forecast after 2027-01-18T00:00:00-06:00']);
    expect(r.reasons).toEqual([
      { kind: 'unknown', message: 'no forecast after 2027-01-18T00:00:00-06:00' },
    ]);
  });

  test('an action past the end of the simulation is UNPROVEN, never SAFE', () => {
    const r = check(home, {
      context: { now: '2027-01-15T17:45:00-06:00' },
      actions: [{ device: 'plug_tv', set: { onOff: false }, at: '2027-01-18T09:00:00-06:00' }],
    });
    expect(r.verdict).toBe('UNPROVEN');
  });

  test('a definite violation makes the plan UNSAFE even when something else is unknown', () => {
    const r = check(home, {
      context: { now: '2027-01-15T21:30:00-06:00' },
      actions: [
        { device: 'dishwasher', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00' },
        { device: 'plug_garage_freezer', set: { onOff: false } },
      ],
    });
    expect(r.verdict).toBe('UNSAFE');
    expect(r.reasons.map((x) => [x.kind, 'rule' in x ? x.rule : null])).toEqual([
      ['violation', 'R1'],
      ['unknown', 'R11'],
    ]);
  });
});
