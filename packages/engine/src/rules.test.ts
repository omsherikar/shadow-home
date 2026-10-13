import { join } from 'node:path';
import type { Home, Rule } from '@shadow-home/twin';
import { loadHome, loadPlan } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import type { Frame } from './conditions.ts';
import { computeHorizon } from './horizon.ts';
import { createRuleTracker, type RuleOutcome } from './rules.ts';
import { simulate } from './simulate.ts';
import { formatIso, toMs } from './time.ts';
import { untrustedSensors } from './trust.ts';

const root = join(import.meta.dirname, '../../..');
const home = loadHome(join(root, 'fixtures/demo-home.json'));
const iso = (ms: number | undefined) => (ms === undefined ? undefined : formatIso(ms, -360));
const START = toMs('2027-01-15T17:45:00-06:00');

/** Frames one minute apart, each a small edit of the home's starting state. */
function frames(edits: ((f: Frame) => void)[]): Frame[] {
  return edits.map((edit, i) => {
    const f: Frame = {
      ms: START + i * 60_000,
      localMinute: 17 * 60 + 45 + i,
      devices: new Map(home.devices.map((d) => [d.id, { ...d.state }])),
      presence: { om: 'home', maya: 'home', sam: 'home' },
      zoneTempC: { house: 20, garage: 9 },
    };
    edit(f);
    return f;
  });
}

function set(f: Frame, device: string, attr: string, value: boolean | number | string) {
  (f.devices.get(device) as Record<string, unknown>)[attr] = value;
}

function outcomes(rules: Rule[], fs: Frame[], untrusted = new Map<string, string>()) {
  const h: Home = { ...home, rules };
  const tracker = createRuleTracker(h, untrusted);
  for (const f of fs) tracker.observe(f);
  return tracker.outcomes();
}

const rule = (id: string) => {
  const r = home.rules.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return r;
};

const summary = (o: RuleOutcome) => [o.rule, o.status, iso(o.firstViolationMs)];
const noop = () => {};
const both =
  (...edits: ((f: Frame) => void)[]) =>
  (f: Frame) => {
    for (const edit of edits) edit(f);
  };
const away = (f: Frame) => {
  f.presence = { om: 'away', maya: 'away', sam: 'away' };
};

describe('rule templates', () => {
  test('always: R1 is violated from the first minute the freezer is off', () => {
    const fs = frames([noop, (f) => set(f, 'plug_garage_freezer', 'onOff', false), noop]);
    expect(outcomes([rule('R1')], fs).map(summary)).toEqual([
      ['R1', 'violated', '2027-01-15T17:46:00-06:00'],
    ]);
  });

  test('never_when: R7 only while nobody is home', () => {
    const heaterOn = (f: Frame) => set(f, 'plug_bedroom_space_heater', 'onOff', true);
    expect(outcomes([rule('R7')], frames([heaterOn, heaterOn])).map(summary)).toEqual([
      ['R7', 'ok', undefined],
    ]);
    expect(outcomes([rule('R7')], frames([heaterOn, both(heaterOn, away)])).map(summary)).toEqual([
      ['R7', 'violated', '2027-01-15T17:46:00-06:00'],
    ]);
  });

  test('keep_between: R3 compares the zone temperature with its limits', () => {
    const cold = (c: number) => (f: Frame) => {
      f.zoneTempC = { house: 20, garage: c };
    };
    expect(outcomes([rule('R3')], frames([cold(4), cold(4.01)])).map(summary)).toEqual([
      ['R3', 'ok', undefined],
    ]);
    expect(outcomes([rule('R3')], frames([cold(4), cold(3.99)])).map(summary)).toEqual([
      ['R3', 'violated', '2027-01-15T17:46:00-06:00'],
    ]);
  });

  test('keep_between: the temperature is unknown when the zone thermostat is untrusted', () => {
    const untrusted = new Map([
      ['garage_thermostat', 'garage_thermostat: silent for 90 minutes, over 10'],
    ]);
    const [o] = outcomes([rule('R3')], frames([noop]), untrusted);
    expect(o?.status).toBe('unknown');
    expect(o?.unknownBecause).toEqual(['garage_thermostat: silent for 90 minutes, over 10']);
  });

  test('never_together: R9 heater with the window open', () => {
    const heater = (f: Frame) => set(f, 'plug_bedroom_space_heater', 'onOff', true);
    const window = (f: Frame) => set(f, 'window_bedroom_main', 'contact', 'open');
    expect(outcomes([rule('R9')], frames([heater, window])).map(summary)).toEqual([
      ['R9', 'ok', undefined],
    ]);
    expect(outcomes([rule('R9')], frames([noop, both(heater, window)])).map(summary)).toEqual([
      ['R9', 'violated', '2027-01-15T17:46:00-06:00'],
    ]);
  });

  test('within_after: R6 needs the lights on and the door unlocked within a minute of smoke', () => {
    const smoke = (f: Frame) => set(f, 'smoke_alarm_kitchen', 'smokeState', 'critical');
    const respond = (f: Frame) => {
      smoke(f);
      set(f, 'light_living', 'onOff', true);
      set(f, 'light_kitchen', 'onOff', true);
      set(f, 'front_door_lock', 'lockState', 'UNLOCKED');
    };
    // The door starts unlocked in the fixture; lock it so only a response unlocks it.
    const lock = (f: Frame) => set(f, 'front_door_lock', 'lockState', 'LOCKED');
    expect(
      outcomes([rule('R6')], frames([lock, both(lock, smoke), respond, respond])).map(summary),
    ).toEqual([['R6', 'ok', undefined]]);
    expect(
      outcomes([rule('R6')], frames([lock, both(lock, smoke), both(lock, smoke)])).map(summary),
    ).toEqual([['R6', 'violated', '2027-01-15T17:47:00-06:00']]);
  });
});

describe('unknowns', () => {
  const untrusted = new Map([['dishwasher_latch', 'dishwasher_latch: battery 4% is under 15%']]);

  test('R11 is fine while the dishwasher is off, whatever the latch says', () => {
    expect(outcomes([rule('R11')], frames([noop, noop]), untrusted).map(summary)).toEqual([
      ['R11', 'ok', undefined],
    ]);
  });

  test('R11 is unknown once the dishwasher runs, and names the sensor', () => {
    const on = (f: Frame) => set(f, 'dishwasher', 'onOff', true);
    const [o] = outcomes([rule('R11')], frames([noop, on]), untrusted);
    expect(o).toMatchObject({
      rule: 'R11',
      status: 'unknown',
      firstUnknownMs: START + 60_000,
      unknownBecause: ['dishwasher_latch: battery 4% is under 15%'],
    });
  });

  test('a rule unknown at one step and broken at a later one is violated', () => {
    const r: Rule = {
      id: 'X2',
      text: 'test',
      author: 'om',
      priority: 'comfort',
      template: 'never_when',
      params: {
        x: { device: 'dishwasher', attr: 'onOff', eq: true },
        when: {
          any: [
            { device: 'dishwasher_latch', attr: 'contact', neq: 'closed' },
            { presence: 'nobody' },
          ],
        },
      },
    };
    const on = (f: Frame) => set(f, 'dishwasher', 'onOff', true);
    const [o] = outcomes([r], frames([on, both(on, away)]), untrusted);
    expect(o).toMatchObject({
      status: 'violated',
      firstUnknownMs: START,
      firstViolationMs: START + 60_000,
    });
  });

  test('a single step reads violated when trusted and unknown when not', () => {
    const r: Rule = {
      id: 'X1',
      text: 'test',
      author: 'om',
      priority: 'comfort',
      template: 'always',
      params: { state: { device: 'dishwasher_latch', attr: 'contact', eq: 'closed' } },
    };
    const trusted = new Map<string, string>();
    const open = (f: Frame) => set(f, 'dishwasher_latch', 'contact', 'open');
    expect(outcomes([r], frames([open]), trusted)[0]?.status).toBe('violated');
    expect(outcomes([r], frames([open]), untrusted)[0]?.status).toBe('unknown');
  });
});

describe('the weekend away plan (P001)', () => {
  test('breaks R1, R2, R3 and R8 in the nominal run, and nothing else', () => {
    const plan = loadPlan(join(root, 'bench/plans/P001.json'));
    const tracker = createRuleTracker(home, untrustedSensors(home, plan));
    simulate(home, plan, 'nominal', computeHorizon(home, plan), (f) => tracker.observe(f));
    const broken = tracker
      .outcomes()
      .filter((o) => o.status !== 'ok')
      .map(summary);
    expect(broken).toEqual([
      ['R1', 'violated', '2027-01-15T17:45:00-06:00'],
      ['R2', 'violated', '2027-01-15T17:45:00-06:00'],
      ['R3', 'violated', '2027-01-16T22:37:00-06:00'],
      ['R8', 'violated', '2027-01-16T07:00:00-06:00'],
    ]);
  });
});
