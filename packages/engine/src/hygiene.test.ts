import { join } from 'node:path';
import type { Plan, PlanAction } from '@shadow-home/twin';
import { loadHome, loadPlan } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { hygiene } from './hygiene.ts';

const root = join(import.meta.dirname, '../../..');
const home = loadHome(join(root, 'fixtures/demo-home.json'));
const NOW = '2027-01-15T17:45:00-06:00';
const at = (hhmm: string, day = 15) => `2027-01-${day}T${hhmm}:00-06:00`;

function plan(actions: PlanAction[]): Plan {
  return { context: { now: NOW }, actions };
}

function summary(p: Plan) {
  return hygiene(home, p).map((f) => [f.code, f.device, f.attr, f.actionIndexes]);
}

describe('hygiene: writes to one attribute at one time', () => {
  test('a group write and a device write that disagree conflict', () => {
    const findings = hygiene(
      home,
      plan([
        { group: 'all_plugs', set: { onOff: false } },
        { device: 'plug_tv', set: { onOff: true } },
      ]),
    );
    expect(findings.map((f) => [f.code, f.device, f.actionIndexes])).toEqual([
      ['conflicting_writes', 'plug_tv', [0, 1]],
    ]);
    expect(findings[0]).toMatchObject({ stage: 'hygiene', attr: 'onOff' });
    expect(findings[0]?.message).toMatch(/order/);
  });

  test('two writes of the same value repeat', () => {
    expect(
      summary(
        plan([
          { device: 'plug_tv', set: { onOff: false } },
          { group: 'all_plugs', set: { onOff: false } },
        ]),
      ),
    ).toEqual([['repeated_write', 'plug_tv', 'onOff', [0, 1]]]);
  });

  test('writes at different times are a schedule, not a conflict', () => {
    expect(
      summary(
        plan([
          { device: 'plug_tv', set: { onOff: false } },
          { device: 'plug_tv', set: { onOff: true }, at: at('20:00') },
        ]),
      ),
    ).toEqual([]);
  });

  test('different attributes of one device do not interact', () => {
    expect(
      summary(plan([{ device: 'light_living', set: { onOff: true, brightness: 30 } }])),
    ).toEqual([]);
  });

  test('an action without `at` and one at now are the same time', () => {
    expect(
      summary(
        plan([
          { device: 'plug_tv', set: { onOff: false } },
          { device: 'plug_tv', set: { onOff: true }, at: NOW },
        ]),
      ),
    ).toEqual([['conflicting_writes', 'plug_tv', 'onOff', [0, 1]]]);
  });
});

describe('hygiene: changes that are never reversed', () => {
  test('a heat-producing plug turned on and left on', () => {
    const findings = hygiene(
      home,
      plan([{ device: 'plug_bedroom_space_heater', set: { onOff: true }, at: at('16:00', 16) }]),
    );
    expect(findings.map((f) => [f.code, f.device, f.actionIndexes])).toEqual([
      ['missing_reversal', 'plug_bedroom_space_heater', [0]],
    ]);
  });

  test('a door unlocked and left unlocked', () => {
    expect(summary(plan([{ device: 'front_door_lock', set: { lockState: 'UNLOCKED' } }]))).toEqual([
      ['missing_reversal', 'front_door_lock', 'lockState', [0]],
    ]);
  });

  test('a later action that turns it back off is enough', () => {
    expect(
      summary(
        plan([
          { device: 'plug_bedroom_space_heater', set: { onOff: true } },
          { device: 'plug_bedroom_space_heater', set: { onOff: false }, at: at('18:45') },
          { device: 'front_door_lock', set: { lockState: 'UNLOCKED' } },
          { device: 'front_door_lock', set: { lockState: 'LOCKED' }, at: at('17:50') },
        ]),
      ),
    ).toEqual([]);
  });

  test('a reversal earlier in time does not count', () => {
    expect(
      summary(
        plan([
          { device: 'plug_bedroom_space_heater', set: { onOff: false } },
          { device: 'plug_bedroom_space_heater', set: { onOff: true }, at: at('21:00') },
        ]),
      ),
    ).toEqual([['missing_reversal', 'plug_bedroom_space_heater', 'onOff', [1]]]);
  });

  test('turning off, locking and non-heating devices need no reversal', () => {
    expect(
      summary(
        plan([
          { device: 'plug_bedroom_space_heater', set: { onOff: false } },
          { device: 'back_door_lock', set: { lockState: 'LOCKED' } },
          { device: 'plug_tv', set: { onOff: true } },
          { device: 'dishwasher', set: { onOff: true } },
        ]),
      ),
    ).toEqual([]);
  });
});

describe('hygiene: collisions with the home routines', () => {
  test('unlocking the door the minute Good night locks it', () => {
    const findings = hygiene(
      home,
      plan([
        { device: 'front_door_lock', set: { lockState: 'UNLOCKED' }, at: at('22:30') },
        { device: 'front_door_lock', set: { lockState: 'LOCKED' }, at: at('23:00') },
      ]),
    );
    expect(findings.map((f) => [f.code, f.device, f.routine, f.actionIndexes])).toEqual([
      ['routine_collision', 'front_door_lock', 'good_night', [0]],
    ]);
    expect(findings[0]?.message).toMatch(/Good night/);
  });

  test('a delayed routine step counts too (Porch light turns off at 23:00)', () => {
    expect(
      hygiene(home, plan([{ device: 'light_porch', set: { onOff: true }, at: at('23:00') }])).map(
        (f) => [f.code, f.routine],
      ),
    ).toEqual([['routine_collision', 'porch_light']]);
  });

  test('a routine step through a group (Good night turns indoor lights off)', () => {
    expect(
      hygiene(home, plan([{ device: 'light_kitchen', set: { onOff: true }, at: at('22:30') }])).map(
        (f) => [f.code, f.device, f.routine],
      ),
    ).toEqual([['routine_collision', 'light_kitchen', 'good_night']]);
  });

  test('the same value at the same minute is no collision', () => {
    expect(
      summary(plan([{ device: 'front_door_lock', set: { lockState: 'LOCKED' }, at: at('22:30') }])),
    ).toEqual([]);
  });

  test('a routine the plan pauses over that time does not collide', () => {
    expect(
      summary(
        plan([
          { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
          { device: 'plug_coffee_maker', set: { onOff: false }, at: at('07:00', 16) },
        ]),
      ),
    ).toEqual([]);
  });

  test('a pause that ends before the write does not hide the collision', () => {
    expect(
      hygiene(
        home,
        plan([
          { routine: 'coffee_at_7', pauseUntil: '2027-01-16T08:00:00-06:00' },
          { device: 'plug_coffee_maker', set: { onOff: false }, at: at('07:00', 17) },
        ]),
      ).map((f) => [f.code, f.routine, f.actionIndexes]),
    ).toEqual([['routine_collision', 'coffee_at_7', [1]]]);
  });

  test('a pause already in the home hides the collision too', () => {
    const paused = structuredClone(home);
    const coffee = paused.routines.find((r) => r.id === 'coffee_at_7');
    if (coffee) coffee.pausedUntil = '2027-01-17T18:00:00-06:00';
    expect(
      hygiene(
        paused,
        plan([{ device: 'plug_coffee_maker', set: { onOff: false }, at: at('07:00', 16) }]),
      ).map((f) => f.code),
    ).toEqual([]);
  });

  test('a disabled routine does not collide', () => {
    const quiet = structuredClone(home);
    for (const r of quiet.routines) r.enabled = false;
    expect(
      hygiene(
        quiet,
        plan([{ device: 'front_door_lock', set: { lockState: 'UNLOCKED' }, at: at('22:30') }]),
      ).map((f) => f.code),
    ).toEqual(['missing_reversal']);
  });
});

describe('hygiene: timing at minute resolution', () => {
  test('two writes in the same minute conflict, whatever their seconds', () => {
    expect(
      summary(
        plan([
          { device: 'plug_tv', set: { onOff: false }, at: '2027-01-15T20:00:00-06:00' },
          { device: 'plug_tv', set: { onOff: true }, at: '2027-01-15T20:00:30-06:00' },
        ]),
      ),
    ).toEqual([['conflicting_writes', 'plug_tv', 'onOff', [0, 1]]]);
  });

  test('a routine that already ran this minute does not collide with a write at now', () => {
    const p: Plan = {
      context: { now: '2027-01-15T22:30:20-06:00' },
      actions: [
        { device: 'front_door_lock', set: { lockState: 'UNLOCKED' } },
        {
          device: 'front_door_lock',
          set: { lockState: 'LOCKED' },
          at: '2027-01-15T22:40:00-06:00',
        },
      ],
    };
    expect(summary(p)).toEqual([]);
  });

  test('…and a pause added now does not pretend to have stopped it', () => {
    const p: Plan = {
      context: { now: '2027-01-15T22:30:20-06:00' },
      actions: [
        { routine: 'good_night', pauseUntil: '2027-01-16T12:00:00-06:00' },
        { device: 'front_door_lock', set: { lockState: 'UNLOCKED' } },
        {
          device: 'front_door_lock',
          set: { lockState: 'LOCKED' },
          at: '2027-01-15T22:40:00-06:00',
        },
      ],
    };
    expect(summary(p)).toEqual([]);
  });

  test('a routine due later this minute still collides', () => {
    const p: Plan = {
      context: { now: '2027-01-15T22:29:50-06:00' },
      actions: [
        {
          device: 'front_door_lock',
          set: { lockState: 'UNLOCKED' },
          at: '2027-01-15T22:30:00-06:00',
        },
        {
          device: 'front_door_lock',
          set: { lockState: 'LOCKED' },
          at: '2027-01-15T22:40:00-06:00',
        },
      ],
    };
    expect(hygiene(home, p).map((f) => [f.code, f.routine])).toEqual([
      ['routine_collision', 'good_night'],
    ]);
  });
});

describe('hygiene: repeated routine pauses', () => {
  test('two pauses of one routine that disagree are flagged, and the later one in the plan wins', () => {
    const findings = hygiene(
      home,
      plan([
        { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
        { routine: 'coffee_at_7', pauseUntil: '2027-01-16T08:00:00-06:00' },
        { device: 'plug_coffee_maker', set: { onOff: false }, at: at('07:00', 17) },
      ]),
    );
    expect(findings.map((f) => [f.code, f.routine, f.actionIndexes])).toEqual([
      ['conflicting_pauses', 'coffee_at_7', [0, 1]],
      ['routine_collision', 'coffee_at_7', [2]],
    ]);
  });

  test('the same pause twice is only repeated', () => {
    expect(
      hygiene(
        home,
        plan([
          { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
          { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
        ]),
      ).map((f) => [f.code, f.routine]),
    ).toEqual([['repeated_pause', 'coffee_at_7']]);
  });
});

describe('hygiene: output', () => {
  test('findings come in action order', () => {
    const findings = hygiene(
      home,
      plan([
        { device: 'front_door_lock', set: { lockState: 'UNLOCKED' }, at: at('22:30') },
        { group: 'all_plugs', set: { onOff: false } },
        { device: 'plug_tv', set: { onOff: true } },
      ]),
    );
    expect(findings.map((f) => [f.actionIndexes[0], f.code])).toEqual([
      [0, 'missing_reversal'],
      [0, 'routine_collision'],
      [1, 'conflicting_writes'],
    ]);
  });

  test('unknown devices are lint’s problem, not hygiene’s', () => {
    expect(summary(plan([{ device: 'sauna', set: { onOff: true } }]))).toEqual([]);
  });

  test('the demo away plan (P001) is tidy: its trouble is physics and routines, not hygiene', () => {
    expect(summary(loadPlan(join(root, 'bench/plans/P001.json')))).toEqual([]);
  });
});
