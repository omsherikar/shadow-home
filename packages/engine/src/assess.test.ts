import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Home, Plan } from '@shadow-home/twin';
import { loadHome, loadPlan } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { assess } from './assess.ts';
import { diffPlan } from './diff.ts';
import { repair, safePart } from './repair.ts';
import { reversibility } from './reversibility.ts';
import { SPEECH_LIMITS, wordCount } from './speech.ts';
import { check } from './verdict.ts';

const root = join(import.meta.dirname, '../../..');
const home = loadHome(join(root, 'fixtures/demo-home.json'));
const bench = (id: string) => loadPlan(join(root, `bench/plans/${id}.json`));
const demo = JSON.parse(readFileSync(join(root, 'fixtures/demo-script.json'), 'utf8')) as {
  beats: {
    id: string;
    expected: { repairs?: string[]; repairedVerdict?: string; tier?: string };
  }[];
};
const beat = (id: string) => demo.beats.find((b) => b.id === id)?.expected;
const NOW = '2027-01-15T17:45:00-06:00';
const plan = (actions: Plan['actions'], now = NOW): Plan => ({ context: { now }, actions });

function expectSpeechWithinLimits(s: { headline: string; reason?: string; ask?: string }) {
  expect(wordCount(s.headline)).toBeLessThanOrEqual(SPEECH_LIMITS.headline);
  if (s.reason) expect(wordCount(s.reason)).toBeLessThanOrEqual(SPEECH_LIMITS.reason);
  if (s.ask) expect(wordCount(s.ask)).toBeLessThanOrEqual(SPEECH_LIMITS.ask);
}

describe('the weekend away plan', () => {
  const a = assess(home, bench('P001'), { requestedBy: 'om' });

  test('is blocked at T3 and repaired to SAFE with the fixes the demo script expects', () => {
    const expected = beat('weekend_away');
    expect(a.tier.tier).toBe(expected?.tier);
    expect(a.repaired?.check.verdict).toBe(expected?.repairedVerdict);
    expect(a.repaired?.detail.repairs.map((r) => r.description).sort()).toEqual(
      [...(expected?.repairs ?? [])].map((s) => s.replace(' °C', ' °C')).sort(),
    );
  });

  test('each repair answers the rule it was made for', () => {
    expect(
      Object.fromEntries((a.repaired?.detail.repairs ?? []).map((r) => [r.rule, r.kind])),
    ).toEqual({
      R1: 'leave_out',
      R2: 'leave_out',
      R3: 'nearest_value',
      R8: 'pause_routine',
    });
  });

  test('the repaired plan is checked again and gets the same verdict on its own', () => {
    const plan = a.repaired?.plan;
    expect(plan).toBeDefined();
    if (plan) expect(check(home, plan)).toEqual(a.repaired?.check);
  });

  test('has no safe part: dropping its own actions leaves the coffee maker running', () => {
    expect(a.safePart).toBeNull();
  });

  test('speaks the block, the most important rule and its author, and offers the fixes', () => {
    expect(a.speech).toEqual({
      headline: 'Blocked: that breaks 4 house rules.',
      reason: "No coffee maker running when nobody's home. That's Om's rule.",
      ask: 'Do it with 4 fixes instead?',
    });
  });

  test('the diff lists what actually changes, not writes that leave a value as it was', () => {
    const rows = a.diff.map((r) => `${r.target}.${r.attr} ${String(r.from)}→${String(r.to)}`);
    expect(rows).toEqual([
      'thermostat_main.heatingSetpointC 20→10',
      'garage_thermostat.systemMode heat→off',
      'plug_garage_freezer.onOff true→false',
      'plug_aquarium.onOff true→false',
      'plug_tv.onOff true→false',
      'light_living.onOff true→false',
      'light_kitchen.onOff true→false',
      'light_bedroom_sam.onOff true→false',
      'light_porch.onOff true→false',
      'front_door_lock.lockState UNLOCKED→LOCKED',
      'home.mode home→away',
    ]);
    expect(a.diff.every((r) => r.reversibility === 'compensable')).toBe(true);
  });
});

describe('the 2 AM dishwasher', () => {
  const a = assess(home, bench('P003'), { requestedBy: 'om' });

  test('is UNPROVEN at T4, asks one question and offers nothing else', () => {
    expect(a.tier.tier).toBe(beat('dishwasher_2am')?.tier);
    expect(a.repaired).toBeNull();
    expect(a.safePart).toBeNull();
    expect(a.speech).toEqual({
      headline: "I can't confirm that's safe.",
      reason:
        'Dishwasher door latch battery is at 4%, so I can\'t check "Don\'t run the dishwasher unless its door is latched".',
      ask: 'Run it anyway?',
    });
  });

  test('is held until 2 AM, so it can still be cancelled', () => {
    expect(a.reversibility).toEqual([
      { actionIndex: 0, reversibility: 'holdable', irreversibleOnceFired: false },
    ]);
  });
});

describe('offering an alternative', () => {
  // Someone is home, so unlocking is SAFE but needs a yes (T2); the freezer makes the plan T3.
  const a = assess(
    home,
    plan(
      [
        { device: 'back_door_lock', set: { lockState: 'UNLOCKED' } },
        { device: 'plug_garage_freezer', set: { onOff: false } },
      ],
      '2027-01-15T21:30:00-06:00',
    ),
    { requestedBy: 'om' },
  );

  test("names the alternative's own consequence, so a yes to it is informed", () => {
    expect(a.tier.tier).toBe('T3');
    expect(a.repaired?.tier.tier).toBe('T2');
    expect(a.offered).toBe('repair');
    expect(a.speech.ask).toBe('Do it with one fix instead? That leaves Back door lock unlocked.');
  });

  test('each alternative carries its own question for when it is committed on its own', () => {
    expect(a.repaired?.speech.ask).toBe('Back door lock unlocked?');
    expect(a.safePart?.speech.ask).toBe('Back door lock unlocked?');
  });
});

describe('confirmation tiers', () => {
  test('T0: a SAFE change to one room, by the person asking', () => {
    const a = assess(home, bench('P002'), { requestedBy: 'om' });
    expect(a.tier.tier).toBe('T0');
    expect(a.speech).toEqual({ headline: 'Safe: Living room lights to 30%.' });
  });

  test('T1: the main thermostat heats the whole house, so it affects everyone else', () => {
    const a = assess(home, plan([{ device: 'thermostat_main', set: { heatingSetpointC: 21 } }]), {
      requestedBy: 'om',
    });
    expect(a.tier).toMatchObject({ tier: 'T1', affects: ['maya', 'sam'] });
    expect(a.speech.reason).toBe('This affects Maya and Sam.');
  });

  test('T1: pausing a routine someone else owns', () => {
    const a = assess(
      home,
      plan([{ routine: 'good_night', pauseUntil: '2027-01-16T12:00:00-06:00' }]),
      { requestedBy: 'om' },
    );
    expect(a.check.verdict).toBe('SAFE');
    expect(a.tier).toMatchObject({ tier: 'T1', affects: ['maya'] });
  });

  test('T2: unlocking a door is SAFE with people home, but needs a yes', () => {
    const a = assess(home, plan([{ device: 'back_door_lock', set: { lockState: 'UNLOCKED' } }]), {
      requestedBy: 'om',
    });
    expect(a.check.verdict).toBe('SAFE');
    expect(a.tier).toMatchObject({ tier: 'T2', sensitive: ['back_door_lock'] });
    expect(a.speech.ask).toBe('Back door lock unlocked?');
  });

  test('T2: a write the device marks irreversible', () => {
    const h: Home = structuredClone(home);
    const dishwasher = h.devices.find((d) => d.id === 'dishwasher');
    if (dishwasher) dishwasher.irreversible = ['onOff'];
    const p: Plan = {
      context: {
        now: NOW,
        stateOverrides: { dishwasher_latch: { sensor: { batteryPercent: 80 } } },
      },
      actions: [{ device: 'dishwasher', set: { onOff: true } }],
    };
    const a = assess(h, p, { requestedBy: 'om' });
    expect(a.check.verdict).toBe('SAFE');
    expect(a.reversibility[0]?.reversibility).toBe('irreversible');
    expect(a.tier).toMatchObject({ tier: 'T2', why: "it can't be undone once it runs" });
    expect(a.speech.reason).toBe("This can't be undone.");
  });

  test('T3: a plan lint rejects', () => {
    const a = assess(home, bench('P005'));
    expect(a.tier.tier).toBe('T3');
    expect(a.speech.headline).toBe("I can't do that as asked.");
    expect(a.repaired).toBeNull();
  });

  test('T5: switching off a smoke alarm is refused outright', () => {
    const a = assess(home, plan([{ device: 'smoke_alarm_kitchen', set: { enabled: false } }]));
    expect(a.tier.tier).toBe('T5');
    expect(a.speech).toEqual({
      headline: "I can't do that.",
      reason: "Smoke alarms can never be turned off. That's Om's rule.",
    });
  });
});

describe('repairs', () => {
  test('a heater switched off where only the cold run freezes moves to the lowest setting that holds', () => {
    // The away-until-Saturday-noon plan from verdict.test.ts: nominal holds, pessimistic breaks R3.
    const until = '2027-01-16T12:00:00-06:00';
    const p: Plan = {
      context: {
        now: NOW,
        presenceSchedule: [{ from: '2027-01-15T18:00:00-06:00', to: until, presence: 'nobody' }],
        planEnd: until,
      },
      actions: [
        { device: 'thermostat_main', set: { heatingSetpointC: 10 } },
        { device: 'garage_thermostat', set: { systemMode: 'off' } },
        { device: 'plug_tv', set: { onOff: false } },
        { device: 'plug_coffee_maker', set: { onOff: false } },
        { device: 'plug_bedroom_space_heater', set: { onOff: false } },
        { group: 'all_lights', set: { onOff: false } },
        { device: 'front_door_lock', set: { lockState: 'LOCKED' } },
        { device: 'back_door_lock', set: { lockState: 'LOCKED' } },
        { mode: 'away' },
        { routine: 'coffee_at_7', pauseUntil: until },
      ],
    };
    const result = check(home, p);
    expect(result.verdict).toBe('UNPROVEN');
    const r = repair(home, p, result);
    expect(r?.result.verdict).toBe('SAFE');
    expect(r?.repairs).toEqual([
      {
        rule: 'R3',
        kind: 'nearest_value',
        actionIndex: 1,
        target: 'garage_thermostat',
        description: 'garage_thermostat heat at 5 °C instead of off',
      },
    ]);
  });

  test('a setpoint moves 1 °C at a time from what was asked, and stops at the first that holds', () => {
    const until = '2027-01-17T18:00:00-06:00';
    const p: Plan = {
      context: {
        now: NOW,
        presenceSchedule: [{ from: '2027-01-15T18:00:00-06:00', to: until, presence: 'nobody' }],
        planEnd: until,
      },
      actions: [
        { device: 'garage_thermostat', set: { heatingSetpointC: 4 } },
        { group: 'indoor_lights', set: { onOff: false } },
        { device: 'front_door_lock', set: { lockState: 'LOCKED' } },
        { routine: 'coffee_at_7', pauseUntil: until },
      ],
    };
    const r = repair(home, p, check(home, p));
    expect(r?.result.verdict).toBe('SAFE');
    expect(r?.repairs.map((x) => x.description)).toEqual([
      'garage_thermostat at 5 °C instead of 4 °C',
    ]);
  });

  const awayFrom = (from: string): Plan['context'] => ({
    now: NOW,
    presenceSchedule: [{ from, to: '2027-01-15T20:00:00-06:00', presence: 'nobody' }],
  });

  test('a step the plan left out is added as everyone leaves: each light still on goes off', () => {
    // Everyone leaves at 18:00 with the lights on: nothing the plan did tipped R10, so the fix is
    // to add the step R10 asks for, for each indoor light on then (the bedroom one is already off).
    const p: Plan = {
      context: awayFrom('2027-01-15T18:00:00-06:00'),
      actions: [{ device: 'plug_tv', set: { onOff: false } }],
    };
    const result = check(home, p);
    const r10 = result.reasons.find((r) => r.kind === 'violation' && r.rule === 'R10');
    expect(r10).toBeDefined();
    expect(r10 && 'cause' in r10).toBe(false);
    const fixed = repair(home, p, result);
    expect(fixed?.result.verdict).toBe('SAFE');
    expect(fixed?.repairs.filter((r) => r.rule === 'R10')).toEqual(
      ['light_living', 'light_kitchen', 'light_bedroom_sam'].map((device) => ({
        rule: 'R10',
        kind: 'add_action',
        target: device,
        description: `turn ${device} off at 18:00`,
      })),
    );
    expect(fixed?.plan.actions).toContainEqual({
      device: 'light_kitchen',
      set: { onOff: false },
      at: '2027-01-15T18:00:00-06:00',
    });
  });

  test('a step needed from the start runs at once', () => {
    const p: Plan = {
      context: awayFrom(NOW),
      actions: [{ device: 'plug_tv', set: { onOff: false } }],
    };
    const fixed = repair(home, p, check(home, p));
    expect(fixed?.result.verdict).toBe('SAFE');
    expect(fixed?.repairs.map((r) => r.description)).toContain('lock front_door_lock');
    expect(fixed?.plan.actions).toContainEqual({
      device: 'front_door_lock',
      set: { lockState: 'LOCKED' },
    });
  });

  test("a break the plan's own action causes is fixed by changing the plan, not by adding a step", () => {
    // The heater is off; the plan turns it on at 19:00 with nobody home (R7).
    const p: Plan = {
      context: awayFrom('2027-01-15T18:00:00-06:00'),
      actions: [
        { group: 'indoor_lights', set: { onOff: false } },
        { device: 'front_door_lock', set: { lockState: 'LOCKED' } },
        {
          device: 'plug_bedroom_space_heater',
          set: { onOff: true },
          at: '2027-01-15T19:00:00-06:00',
        },
      ],
    };
    const fixed = repair(home, p, check(home, p));
    expect(fixed?.result.verdict).toBe('SAFE');
    expect(fixed?.repairs).toEqual([
      {
        rule: 'R7',
        kind: 'drop_action',
        actionIndex: 2,
        target: 'plug_bedroom_space_heater',
        description: 'keep plug_bedroom_space_heater off',
      },
    ]);
  });

  test('a dropped action is described by the value just before it, which an added step may set', () => {
    // The door starts unlocked: the search locks it as everyone leaves, then the plan's own 19:00
    // unlock breaks R4 again and is left out, so the door stays locked, not unlocked.
    const p: Plan = {
      context: awayFrom('2027-01-15T18:00:00-06:00'),
      actions: [
        { group: 'indoor_lights', set: { onOff: false } },
        {
          device: 'front_door_lock',
          set: { lockState: 'UNLOCKED' },
          at: '2027-01-15T19:00:00-06:00',
        },
      ],
    };
    const fixed = repair(home, p, check(home, p));
    expect(fixed?.result.verdict).toBe('SAFE');
    expect(fixed?.repairs.map((r) => r.description)).toEqual([
      'lock front_door_lock at 18:00',
      'keep front_door_lock lockState at LOCKED',
    ]);
  });

  test('nothing to repair on a SAFE plan', () => {
    const p = bench('P002');
    expect(repair(home, p, check(home, p))).toBeNull();
    expect(safePart(home, p, check(home, p))).toBeNull();
  });
});

describe('the safe part', () => {
  test('drops the action that broke a rule and keeps the rest', () => {
    const p = plan([
      { device: 'plug_tv', set: { onOff: false } },
      { device: 'plug_garage_freezer', set: { onOff: false } },
      { device: 'light_living', set: { brightness: 30 } },
    ]);
    const part = safePart(home, p, check(home, p));
    expect(part?.dropped).toEqual([1]);
    expect(part?.result.verdict).toBe('SAFE');
    expect(part?.plan.actions).toEqual([p.actions[0], p.actions[2]]);
  });

  test('drops an action lint rejects', () => {
    const p = plan([
      { device: 'plug_tv', set: { onOff: false } },
      { device: 'sauna', set: { onOff: true } },
    ]);
    expect(safePart(home, p, check(home, p))?.dropped).toEqual([1]);
  });

  test('drops an action on a device an undecidable rule reads', () => {
    const p = plan(
      [
        { device: 'dishwasher', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00' },
        { device: 'light_kitchen', set: { onOff: false } },
      ],
      '2027-01-15T21:30:00-06:00',
    );
    const part = safePart(home, p, check(home, p));
    expect(part?.dropped).toEqual([0]);
    expect(part?.result.verdict).toBe('SAFE');
  });
});

describe('reversibility and the diff', () => {
  test('an action in a later minute is holdable; one at now has fired', () => {
    const p = plan([
      { device: 'plug_tv', set: { onOff: false } },
      { device: 'plug_tv', set: { onOff: true }, at: '2027-01-15T17:45:30-06:00' },
      { device: 'plug_tv', set: { onOff: false }, at: '2027-01-15T17:46:00-06:00' },
    ]);
    expect(reversibility(home, p).map((t) => t.reversibility)).toEqual([
      'compensable',
      'compensable',
      'holdable',
    ]);
  });

  test('a routine pause and a mode change are rows of their own', () => {
    const rows = diffPlan(
      home,
      plan([{ routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' }, { mode: 'away' }]),
    );
    expect(rows).toMatchObject([
      { kind: 'routine', target: 'coffee_at_7', from: null, to: '2027-01-17T18:00:00-06:00' },
      { kind: 'mode', target: 'home', from: 'home', to: 'away' },
    ]);
  });

  test('the last write to an attribute wins, and the diff compares with the state before the plan', () => {
    const rows = diffPlan(
      home,
      plan([
        { device: 'light_living', set: { brightness: 30 } },
        { device: 'light_living', set: { brightness: 50 } },
      ]),
    );
    expect(rows).toMatchObject([{ target: 'light_living', from: 70, to: 50, actionIndex: 1 }]);
  });
});

describe('speech', () => {
  test.each(['P001', 'P002', 'P003', 'P004', 'P005'])('%s stays within the word limits', (id) => {
    const a = assess(home, bench(id));
    expectSpeechWithinLimits(a.speech);
    if (a.repaired) expect(a.repaired.check.verdict).not.toBe('UNSAFE');
  });
});

describe('leaving, with nothing to change', () => {
  // "I'm heading out": nobody home from now for four hours, and no actions.
  const leaving = (stateOverrides?: Plan['context']['stateOverrides']): Plan => ({
    context: {
      now: NOW,
      presenceSchedule: [{ from: NOW, to: '2027-01-15T21:45:00-06:00', presence: 'nobody' }],
      ...(stateOverrides ? { stateOverrides } : {}),
    },
    actions: [],
  });
  // The demo home with the front door locked and the indoor lights off: ready to leave.
  const ready = {
    front_door_lock: { state: { lockState: 'LOCKED' } },
    light_living: { state: { onOff: false } },
    light_kitchen: { state: { onOff: false } },
    light_bedroom_sam: { state: { onOff: false } },
  };

  test('goes through every stage: lint and hygiene find nothing, and three runs look 12 h ahead', () => {
    const r = check(home, leaving());
    expect(r.lint.ok).toBe(true);
    expect(r.hygiene).toEqual([]);
    expect(r.horizon).toEqual({ start: NOW, end: '2027-01-16T05:45:00-06:00' });
    expect(Object.keys(r.runs ?? {})).toEqual(['nominal', 'pessimistic', 'optimistic']);
  });

  test('is UNSAFE when the house breaks a nobody-home rule, and the fix adds each missing step', () => {
    const a = assess(home, leaving(), { requestedBy: 'om' });
    expect(a.check.verdict).toBe('UNSAFE');
    expect(a.tier.tier).toBe('T3');
    expect(a.check.reasons.map((r) => r.kind === 'violation' && r.rule)).toEqual(['R4', 'R10']);
    expect(a.diff).toEqual([]);
    expect(a.repaired?.detail.repairs).toEqual([
      {
        rule: 'R4',
        kind: 'add_action',
        target: 'front_door_lock',
        description: 'lock front_door_lock',
      },
      ...['light_living', 'light_kitchen', 'light_bedroom_sam'].map((device) => ({
        rule: 'R10',
        kind: 'add_action',
        target: device,
        description: `turn ${device} off`,
      })),
    ]);
    expect(a.repaired?.check.verdict).toBe('SAFE');
    expect(a.repaired?.tier.tier).toBe('T0');
    expect(a.offered).toBe('repair');
  });

  test('has no safe part: there are no actions to keep', () => {
    expect(assess(home, leaving()).safePart).toBeNull();
  });

  test('says what to put right before going, and offers to do it', () => {
    const a = assess(home, leaving(), { requestedBy: 'om' });
    expect(a.speech).toEqual({
      headline: 'Before you go: Front door lock unlocked, Living room lights on and 2 more.',
      reason: "Front door locked when nobody's home. That's Om's rule.",
      ask: 'Shall I fix all 4?',
    });
    expectSpeechWithinLimits(a.speech);
  });

  test('names both when two things are wrong, the more important first', () => {
    const a = assess(
      home,
      leaving({
        ...ready,
        back_door_lock: { state: { lockState: 'UNLOCKED' } },
        plug_bedroom_space_heater: { state: { onOff: true } },
      }),
    );
    expect(a.speech).toEqual({
      headline: 'Before you go: Bedroom space heater on and Back door lock unlocked.',
      reason: "Space heater off when nobody's home. That's Maya's rule.",
      ask: 'Shall I fix both?',
    });
  });

  test('is SAFE, with nothing to fix and nothing to ask, when the house is ready', () => {
    const a = assess(home, leaving(ready));
    expect(a.check.verdict).toBe('SAFE');
    expect(a.tier.tier).toBe('T0');
    expect(a.repaired).toBeNull();
    expect(a.safePart).toBeNull();
    expect(a.speech).toEqual({ headline: "You're all set: nothing needs changing before you go." });
  });

  test("can't confirm a lock whose battery is low, and asks nothing: there is nothing to run", () => {
    const lowLock = { state: { lockState: 'LOCKED' }, sensor: { batteryPercent: 9 } };
    const a = assess(home, leaving({ ...ready, front_door_lock: lowLock }));
    expect(a.check.verdict).toBe('UNPROVEN');
    expect(a.tier.tier).toBe('T4');
    expect(a.speech).toEqual({
      headline: "Before you go: I can't confirm the house will be safe.",
      reason: `Front door lock battery is at 9%, so I can't check "Front door locked when nobody's home".`,
    });
    expectSpeechWithinLimits(a.speech);
  });
});
