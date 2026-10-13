import { join } from 'node:path';
import type { Home, Plan, PlanAction } from '@shadow-home/twin';
import { loadHome, loadPlan } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import type { Frame } from './conditions.ts';
import { computeHorizon } from './horizon.ts';
import { type RunName, simulate } from './simulate.ts';
import { formatIso, toMs } from './time.ts';

const root = join(import.meta.dirname, '../../..');
const home = loadHome(join(root, 'fixtures/demo-home.json'));
const p001 = loadPlan(join(root, 'bench/plans/P001.json'));
const t = (local: string) => toMs(`${local}-06:00`);
const iso = (ms: number) => formatIso(ms, -360);

/** Run a plan and collect every frame's garage temperature and a few device states. */
function run(plan: Plan, name: RunName = 'nominal', h: Home = home) {
  const frames: Frame[] = [];
  const result = simulate(h, plan, name, computeHorizon(h, plan), (f) => {
    frames.push({
      ...f,
      devices: new Map([...f.devices].map(([id, s]) => [id, { ...s }])),
      zoneTempC: { ...f.zoneTempC },
    });
  });
  const garage = frames.map((f) => ({ ms: f.ms, tempC: f.zoneTempC.garage ?? Number.NaN }));
  const firstBelow = (limit: number) => garage.find((g) => g.tempC < limit)?.ms;
  const minGarage = Math.min(...garage.map((g) => g.tempC));
  return { frames, result, firstBelow, minGarage };
}

// The repaired weekend plan from fixtures/README.md, with the garage heater at `garageC`.
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

describe('the heating model against the fixture reference run', () => {
  // fixtures/README.md: a throwaway reference simulation, run before any engine code existed.
  test.each<[RunName, string, number]>([
    ['nominal', '2027-01-16T22:36:00', 0.27],
    ['pessimistic', '2027-01-16T02:42:00', -2.08],
    ['optimistic', '2027-01-17T03:56:00', 2.64],
  ])('the draft away plan, %s run: garage below 4 °C at %s, minimum %f °C', (name, at, min) => {
    const r = run(p001, name);
    const first = r.firstBelow(4);
    expect(first, 'the garage never fell below 4 °C').toBeDefined();
    expect(
      Math.abs((first ?? 0) - t(at)) / 60_000,
      `first below 4 °C at ${iso(first ?? 0)}`,
    ).toBeLessThanOrEqual(5);
    expect(r.minGarage).toBeCloseTo(min, 1);
  });

  test.each<RunName>(['nominal', 'pessimistic', 'optimistic'])(
    'the repaired plan holds the garage at 4.49 °C or above (%s)',
    (name) => {
      expect(run(repaired(5), name).minGarage).toBeGreaterThanOrEqual(4.45);
      expect(run(repaired(5), name).minGarage).toBeLessThan(4.5);
    },
  );

  test('a 4.5 °C garage setting dips just under 4 °C in the pessimistic run', () => {
    expect(run(repaired(4.5), 'pessimistic').minGarage).toBeCloseTo(3.99, 1);
    expect(run(repaired(4.5), 'pessimistic').minGarage).toBeLessThan(4);
  });
});

describe('thermostats', () => {
  test('with no plan, both zones stay within the hysteresis band of their setpoints', () => {
    const r = run({ context: { now: '2027-01-15T17:45:00-06:00' }, actions: [] });
    for (const f of r.frames) {
      expect(f.zoneTempC.house).toBeGreaterThanOrEqual(19.45);
      expect(f.zoneTempC.house).toBeLessThanOrEqual(20.55);
      expect(f.zoneTempC.garage).toBeGreaterThanOrEqual(8.45);
      expect(f.zoneTempC.garage).toBeLessThanOrEqual(9.55);
    }
  });

  test('the thermostat reading follows the zone temperature', () => {
    const r = run(p001);
    const last = r.frames.at(-1);
    expect(last?.devices.get('garage_thermostat')?.localTemperatureC).toBeCloseTo(
      last?.zoneTempC.garage ?? Number.NaN,
      6,
    );
  });
});

describe('events', () => {
  const changesOf = (plan: Plan) =>
    run(plan).result.changes.map((c) => [iso(c.atMs), c.source, c.device, c.attr, c.to]);

  test('plan actions apply at now, group writes expand, and only real changes are recorded', () => {
    const changes = run(p001).result.changes.filter((c) => c.source === 'plan');
    expect(changes.map((c) => c.device)).toEqual([
      'thermostat_main',
      'garage_thermostat',
      'plug_garage_freezer',
      'plug_aquarium',
      'plug_tv',
      'light_living',
      'light_kitchen',
      'light_bedroom_sam',
      'light_porch',
      'front_door_lock',
      'home',
    ]);
    expect(changes.every((c) => c.atMs === t('2027-01-15T17:45:00'))).toBe(true);
  });

  test('routines run inside the simulation, including a step from a run that began before now', () => {
    const routine = run(p001).result.changes.filter((c) => c.source !== 'plan');
    expect(routine.map((c) => [iso(c.atMs), c.source, c.device, c.to])).toEqual([
      // Porch light's 23:00 Friday step changes nothing: the plan already turned the porch off.
      ['2027-01-16T07:00:00-06:00', 'coffee_at_7', 'plug_coffee_maker', true],
      ['2027-01-16T07:30:00-06:00', 'coffee_at_7', 'plug_coffee_maker', false],
      ['2027-01-16T17:30:00-06:00', 'porch_light', 'light_porch', true],
      ['2027-01-16T23:00:00-06:00', 'porch_light', 'light_porch', false],
      ['2027-01-17T07:00:00-06:00', 'coffee_at_7', 'plug_coffee_maker', true],
      ['2027-01-17T07:30:00-06:00', 'coffee_at_7', 'plug_coffee_maker', false],
      ['2027-01-17T17:30:00-06:00', 'porch_light', 'light_porch', true],
    ]);
  });

  test('a paused routine does not trigger until the pause ends', () => {
    const changes = run(repaired(5)).result.changes;
    expect(changes.some((c) => c.source === 'coffee_at_7')).toBe(false);
  });

  test('a pause already in the home holds, and a pause in the plan replaces it', () => {
    const paused = structuredClone(home);
    const coffee = paused.routines.find((r) => r.id === 'coffee_at_7');
    if (coffee) coffee.pausedUntil = '2027-01-16T12:00:00-06:00';
    const coffeeRuns = (plan: Plan) =>
      run(plan, 'nominal', paused)
        .result.changes.filter((c) => c.source === 'coffee_at_7' && c.to === true)
        .map((c) => iso(c.atMs));
    expect(coffeeRuns(p001)).toEqual(['2027-01-17T07:00:00-06:00']);
    const shorter: Plan = {
      ...p001,
      actions: [{ routine: 'coffee_at_7', pauseUntil: '2027-01-15T18:00:00-06:00' }],
    };
    expect(coffeeRuns(shorter)).toEqual(['2027-01-16T07:00:00-06:00', '2027-01-17T07:00:00-06:00']);
  });

  test('writes an earlier plan scheduled run at their time, after routines and before the plan', () => {
    const withScheduled = structuredClone(home);
    withScheduled.scheduled = [
      { device: 'dishwasher', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00', source: 'p1' },
      { device: 'plug_tv', set: { onOff: false }, at: '2027-01-15T17:00:00-06:00', source: 'p1' },
      {
        device: 'front_door_lock',
        set: { lockState: 'UNLOCKED' },
        at: '2027-01-15T22:30:00-06:00',
        source: 'p1',
      },
    ];
    const plan: Plan = {
      context: { now: '2027-01-15T21:00:00-06:00' },
      actions: [
        {
          device: 'front_door_lock',
          set: { lockState: 'LOCKED' },
          at: '2027-01-15T22:30:00-06:00',
        },
      ],
    };
    const changes = run(plan, 'nominal', withScheduled).result.changes;
    const of = (device: string) =>
      changes.filter((c) => c.device === device).map((c) => [iso(c.atMs), c.source, c.to]);
    expect(of('dishwasher')).toEqual([['2027-01-16T02:00:00-06:00', 'p1', true]]);
    // Its time had passed: it already ran, or never will.
    expect(of('plug_tv')).toEqual([]);
    expect(of('front_door_lock')).toEqual([
      ['2027-01-15T22:30:00-06:00', 'good_night', 'LOCKED'],
      ['2027-01-15T22:30:00-06:00', 'p1', 'UNLOCKED'],
      ['2027-01-15T22:30:00-06:00', 'plan', 'LOCKED'],
    ]);
  });

  test('the simulation runs through the last scheduled write', () => {
    const withScheduled = structuredClone(home);
    withScheduled.scheduled = [
      { device: 'plug_tv', set: { onOff: false }, at: '2027-01-16T20:00:00-06:00', source: 'p1' },
    ];
    const plan: Plan = { context: { now: '2027-01-15T21:00:00-06:00' }, actions: [] };
    expect(iso(computeHorizon(withScheduled, plan).endMs)).toBe('2027-01-16T20:00:00-06:00');
  });

  test('in one minute the routine runs first and the plan wins', () => {
    const plan: Plan = {
      context: { now: '2027-01-15T21:00:00-06:00' },
      actions: [
        {
          device: 'front_door_lock',
          set: { lockState: 'UNLOCKED' },
          at: '2027-01-15T22:30:00-06:00',
        },
      ],
    };
    expect(changesOf(plan).filter(([, , d]) => d === 'front_door_lock')).toEqual([
      ['2027-01-15T22:30:00-06:00', 'good_night', 'front_door_lock', 'lockState', 'LOCKED'],
      ['2027-01-15T22:30:00-06:00', 'plan', 'front_door_lock', 'lockState', 'UNLOCKED'],
    ]);
  });

  test('presence follows the schedule, with windows open at the start and closed at the end', () => {
    const r = run(p001);
    const at = (local: string) => r.frames.find((f) => f.ms === t(local))?.presence;
    expect(at('2027-01-15T17:59:00')).toEqual({ om: 'home', maya: 'home', sam: 'home' });
    expect(at('2027-01-15T18:00:00')).toEqual({ om: 'away', maya: 'away', sam: 'away' });
    expect(at('2027-01-17T17:59:00')).toEqual({ om: 'away', maya: 'away', sam: 'away' });
    expect(at('2027-01-17T18:00:00')).toEqual({ om: 'home', maya: 'home', sam: 'home' });
  });

  test('a presence window can name who is home', () => {
    const plan: Plan = {
      context: {
        now: '2027-01-16T08:00:00-06:00',
        presenceSchedule: [
          {
            from: '2027-01-16T09:00:00-06:00',
            to: '2027-01-16T12:00:00-06:00',
            presence: { home: ['sam'] },
          },
        ],
      },
      actions: [],
    };
    const f = run(plan).frames.find((x) => x.ms === t('2027-01-16T10:00:00'));
    expect(f?.presence).toEqual({ om: 'away', maya: 'away', sam: 'home' });
  });

  test('state overrides set the starting state', () => {
    const plan: Plan = {
      context: {
        now: '2027-01-15T17:45:00-06:00',
        stateOverrides: { window_bedroom_main: { state: { contact: 'open' } } },
      },
      actions: [],
    };
    expect(run(plan).frames[0]?.devices.get('window_bedroom_main')?.contact).toBe('open');
  });

  test('the loop guard caps routine actions in one step', () => {
    const busy = structuredClone(home);
    for (let i = 0; i < 60; i++) {
      busy.routines.push({
        id: `r${i}`,
        name: `R ${i}`,
        owner: 'om',
        enabled: true,
        trigger: { type: 'time', at: '19:00', days: 'daily' },
        actions: [{ device: 'plug_tv', set: { onOff: i % 2 === 0 } }],
      });
    }
    const r = run({ context: { now: '2027-01-15T17:45:00-06:00' }, actions: [] }, 'nominal', busy);
    expect(r.result.loopGuardTrippedAt.map(iso)).toEqual(['2027-01-15T19:00:00-06:00']);
  });
});
