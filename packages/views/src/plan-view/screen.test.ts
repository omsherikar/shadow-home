import { describe, expect, test } from 'vitest';
import { clock, midnights, shortName, when } from './format.ts';
import {
  commitScreen,
  fixLabel,
  MAX_CARDS,
  MAX_ROWS,
  previewScreen,
  screenFor,
  undoScreen,
} from './screen.ts';
import { type Temperatures, temperaturesFrom } from './temperature.ts';
import {
  type DiffRow,
  type Names,
  type Preview,
  TEMPERATURE_RULES_META_KEY,
  TEMPERATURES_META_KEY,
  type TemperatureTrace,
  type Tier,
  type Verdict,
} from './types.ts';

const NOW = '2027-01-15T21:30:00-06:00';

const names: Names = {
  devices: {
    light_living: { name: 'Living room lights', room: 'Living room' },
    light_kitchen: { name: 'Kitchen lights', room: 'Kitchen' },
    light_bedroom_main: { name: 'Main bedroom lamp', room: 'Main bedroom' },
    light_bedroom_sam: { name: "Sam's room light", room: "Sam's room" },
    plug_garage_freezer: { name: 'Garage freezer', room: 'Garage' },
    back_door_lock: { name: 'Back door lock', room: 'Kitchen' },
    dishwasher: { name: 'Dishwasher', room: 'Kitchen' },
    dishwasher_latch: { name: 'Dishwasher door latch', room: 'Kitchen' },
    smoke_alarm_kitchen: { name: 'Kitchen smoke alarm', room: 'Kitchen' },
  },
  routines: { coffee_at_7: 'Coffee at 7' },
  members: { om: 'Om' },
};

function row(target: string, attr: string, from: DiffRow['from'], to: DiffRow['to']): DiffRow {
  return {
    target,
    name: names.devices[target]?.name ?? target,
    kind: target === 'home' ? 'mode' : 'device',
    attr,
    from,
    to,
    at: NOW,
    actionIndex: 0,
    reversibility: 'compensable',
  };
}

function preview(verdict: Verdict, tier: Tier, more: Partial<Preview> = {}): Preview {
  return {
    planId: 'plan-1',
    kind: 'plan',
    verdict,
    tier,
    speech: { headline: 'Safe: Living room lights off.' },
    diff: [row('light_living', 'onOff', true, false)],
    timeline: [],
    violations: [],
    invalid: [],
    unknowns: [],
    horizon: { start: NOW, end: NOW },
    repair: null,
    safePart: null,
    ...more,
  };
}

describe('times read as the home’s wall clock', () => {
  test('whatever zone the screen is in', () => {
    expect(clock('2027-01-16T22:37:00-06:00')).toBe('Sat 10:37 PM');
    expect(clock('2027-01-17T00:05:00-06:00')).toBe('Sun 12:05 AM');
    expect(clock('2027-01-16T12:00:00-06:00')).toBe('Sat 12:00 PM');
  });

  test('the minute the check started reads as now', () => {
    expect(when('2027-01-15T21:30:40-06:00', NOW)).toBe('now');
    expect(when('2027-01-15T21:31:00-06:00', NOW)).toBe('Fri 9:31 PM');
  });

  test('day lines fall at the home’s midnights inside the window', () => {
    expect(
      midnights('2027-01-15T17:45:00-06:00', '2027-01-17T18:00:00-06:00').map((d) => d.label),
    ).toEqual(['Sat', 'Sun']);
    expect(midnights(NOW, '2027-01-15T23:00:00-06:00')).toEqual([]);
  });
});

describe('rows of changes', () => {
  test('a device in a row named for its room drops the room from its name', () => {
    expect(shortName('Living room lights', 'Living room')).toBe('Lights');
    expect(shortName("Sam's room light", "Sam's room")).toBe('Light');
    expect(shortName('Aquarium heater', 'Living room')).toBe('Aquarium heater');
  });

  test('changes are grouped by room, the mode and routines under Home, last', () => {
    const s = previewScreen(
      preview('SAFE', 'T1', {
        diff: [
          row('home', 'mode', 'home', 'away'),
          row('light_living', 'onOff', true, false),
          row('light_kitchen', 'onOff', true, false),
          row('back_door_lock', 'lockState', 'UNLOCKED', 'LOCKED'),
        ],
      }),
      names,
    );
    expect(s.rows).toEqual([
      { place: 'Living room', chips: [{ text: 'Lights off' }] },
      { place: 'Kitchen', chips: [{ text: 'Lights off' }, { text: 'Back door lock locked' }] },
      { place: 'Home', chips: [{ text: 'Away mode' }] },
    ]);
  });

  test(`never more than ${MAX_ROWS} rows: the rest are counted by room`, () => {
    const s = previewScreen(
      preview('SAFE', 'T1', {
        diff: [
          row('light_living', 'onOff', true, false),
          row('light_kitchen', 'onOff', true, false),
          row('light_bedroom_main', 'onOff', true, false),
          row('light_bedroom_sam', 'onOff', true, false),
          row('plug_garage_freezer', 'onOff', true, false),
          row('home', 'mode', 'home', 'away'),
        ],
      }),
      names,
    );
    expect(s.rows).toHaveLength(MAX_ROWS);
    expect(s.rows.at(-1)).toEqual({
      place: 'Also',
      chips: [{ text: 'Garage: 1 change' }, { text: 'Home: 1 change' }],
    });
  });

  test('a row with a change that breaks a rule comes first, flagged', () => {
    const s = previewScreen(
      preview('UNSAFE', 'T3', {
        diff: [
          row('light_living', 'onOff', true, false),
          row('plug_garage_freezer', 'onOff', true, false),
        ],
        violations: [
          {
            rule: 'R1',
            text: 'Never turn off the garage freezer.',
            author: 'om',
            priority: 'device-protection',
            run: 'nominal',
            firstAt: NOW,
            cause: {
              at: NOW,
              source: 'plan',
              actionIndex: 0,
              device: 'plug_garage_freezer',
              attr: 'onOff',
              from: true,
              to: false,
            },
          },
        ],
      }),
      names,
    );
    expect(s.rows[0]).toEqual({
      place: 'Garage',
      chips: [{ text: 'Freezer off', tone: 'flagged' }],
    });
    expect(s.cards).toEqual([
      {
        id: 'R1',
        cause: 'Your plan: Garage freezer off',
        at: 'now',
        rule: 'Never turn off the garage freezer.',
        author: 'Om',
      },
    ]);
    // Blocked with nothing to offer: the only control closes it.
    expect(s.controls.map((c) => c.label)).toEqual(['OK']);
  });

  test('a write later than now says when, and is marked as later', () => {
    const later = { ...row('dishwasher', 'onOff', false, true), at: '2027-01-16T02:00:00-06:00' };
    const s = previewScreen(preview('SAFE', 'T0', { diff: [later] }), names);
    expect(s.rows[0]?.chips).toEqual([{ text: 'Dishwasher on at Sat 2:00 AM', tone: 'later' }]);
  });
});

describe('what each fix did, in a few words', () => {
  test('a step the fix added says what it sets and when; one at once says now', () => {
    const later = {
      ...row('back_door_lock', 'lockState', 'UNLOCKED', 'LOCKED'),
      at: '2027-01-15T22:00:00-06:00',
    };
    const p = preview('UNSAFE', 'T3', {
      repair: { planId: 'r1', verdict: 'SAFE', tier: 'T3', diff: [later], changes: [] },
    });
    const step = {
      rule: 'R5',
      kind: 'add_action' as const,
      target: 'back_door_lock',
      description: 'lock back_door_lock at 22:00',
    };
    expect(fixLabel(step, p, names)).toBe('Back door lock locked Fri 10:00 PM');
    const atOnce = preview('UNSAFE', 'T3', {
      repair: {
        planId: 'r1',
        verdict: 'SAFE',
        tier: 'T3',
        diff: [row('back_door_lock', 'lockState', 'UNLOCKED', 'LOCKED')],
        changes: [],
      },
    });
    expect(fixLabel(step, atOnce, names)).toBe('Back door lock locked now');
  });
});

describe('controls, each with the words that do the same by voice', () => {
  const said = (p: Preview) =>
    previewScreen(p, names).controls.map((c) => [c.label, c.say, c.action]);

  test('safe and shared: do it, or cancel', () => {
    expect(said(preview('SAFE', 'T1'))).toEqual([
      ['Do it', 'yes', { kind: 'commit', planId: 'plan-1' }],
      ['Cancel', 'cancel', { kind: 'dismiss' }],
    ]);
  });

  test('safe but needs a yes: the question is on screen with its answer', () => {
    const s = previewScreen(
      preview('SAFE', 'T2', {
        speech: { headline: 'Safe, but it needs a yes.', ask: 'Back door lock unlocked?' },
      }),
      names,
    );
    expect(s.ask).toBe('Back door lock unlocked?');
    expect(s.controls[0]).toMatchObject({ label: 'Yes, do it', say: 'yes' });
  });

  test('unproven with a part it can confirm: that part first, run it anyway second', () => {
    const p = preview('UNPROVEN', 'T4', {
      unknowns: ['dishwasher_latch battery 4% (below 15%)'],
      safePart: { planId: 'safe-1', verdict: 'SAFE', tier: 'T0', diff: [], dropped: [1] },
    });
    expect(said(p)).toEqual([
      [
        'Just the part I can confirm',
        'yes',
        { kind: 'commit', planId: 'plan-1', safePartOnly: true },
      ],
      ['Run it anyway', 'run it anyway', { kind: 'commit', planId: 'plan-1' }],
      ['Cancel', 'cancel', { kind: 'dismiss' }],
    ]);
    // Device IDs in the server's message read as names.
    expect(previewScreen(p, names).notes).toEqual(['Dishwasher door latch battery 4% (below 15%)']);
  });

  test('refused by a rule: nothing to do but close it', () => {
    expect(said(preview('UNSAFE', 'T5'))).toEqual([['OK', 'okay', { kind: 'dismiss' }]]);
    expect(previewScreen(preview('UNSAFE', 'T5'), names)).toMatchObject({ icon: '✋' });
  });

  test(`at most ${MAX_CARDS} cards; the other broken rules are counted`, () => {
    const v = (rule: string) => ({
      rule,
      text: `Rule ${rule}.`,
      author: 'om',
      priority: 'comfort',
      run: 'nominal',
      firstAt: NOW,
    });
    const s = previewScreen(
      preview('UNSAFE', 'T3', { violations: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map(v) }),
      names,
    );
    expect(s.cards).toHaveLength(MAX_CARDS);
    expect(s.notes).toContain('2 more rules broken');
  });
});

describe('after a commit and for an undo', () => {
  test('a stale plan shows the fresh check, and says why', () => {
    const s = commitScreen({
      status: 'refused',
      reason: 'state_changed',
      planId: 'plan-1',
      speech: { headline: 'The home changed.' },
      applied: [],
      held: [],
      freshPreview: preview('SAFE', 'T0', { planId: 'plan-2' }),
    });
    expect(s.notes).toEqual(['The home changed since that check, so I checked again.']);
    expect(s.controls[0]?.action).toEqual({ kind: 'commit', planId: 'plan-2' });
  });

  test('a held write is marked later, and can still be undone', () => {
    const s = commitScreen(
      {
        status: 'committed',
        planId: 'plan-1',
        speech: { headline: 'Done: Dishwasher on.' },
        applied: [],
        held: [{ target: 'dishwasher', attr: 'onOff', from: false, to: true }],
        undoToken: 'u1',
      },
      names,
    );
    expect(s.rows).toEqual([
      { place: 'Kitchen', chips: [{ text: 'Dishwasher on', tone: 'later' }] },
    ]);
    expect(s.controls[0]).toMatchObject({ label: 'Undo', action: { kind: 'undo', token: 'u1' } });
  });

  test('a question for a different plan gets its own yes', () => {
    const s = commitScreen({
      status: 'needs_confirmation',
      planId: 'safe-1',
      speech: { headline: 'Just the safe part needs a yes.', ask: 'Back door lock unlocked?' },
      applied: [],
      held: [],
    });
    expect(s.controls[0]).toMatchObject({
      label: 'Yes',
      action: { kind: 'commit', planId: 'safe-1' },
    });
  });

  test('an undo shows what goes back, and what cannot', () => {
    const s = undoScreen(
      {
        status: 'preview',
        preview: preview('SAFE', 'T1', { kind: 'undo' }),
        cannotUndo: [
          { target: 'dishwasher', attr: 'onOff', why: "it can't be undone once it has run" },
        ],
        notes: ['Coffee at 7 resumes.'],
        speech: { headline: 'Undo: Living room lights on.' },
      },
      names,
    );
    expect(s).toMatchObject({
      rowsTitle: 'Putting back',
      headline: 'Undo: Living room lights on.',
    });
    expect(s.notes).toEqual([
      'Coffee at 7 resumes.',
      "Dishwasher can't be put back: it can't be undone once it has run.",
    ]);
    expect(s.controls.map((c) => [c.label, c.say])).toEqual([
      ['Undo it', 'yes'],
      ['Keep it', 'cancel'],
    ]);
  });

  test('an undo that needs more than a yes offers what the check offered, not the whole undo', () => {
    const blocked = preview('UNSAFE', 'T3', {
      kind: 'undo',
      repair: { planId: 'r1', verdict: 'SAFE', tier: 'T1', diff: [], changes: [] },
    });
    expect(previewScreen(blocked, names).controls.map((c) => [c.label, c.action])).toEqual([
      ['Do it with 0 fixes', { kind: 'commit', planId: 'r1' }],
      ['Keep it', { kind: 'dismiss' }],
    ]);
    const unproven = preview('UNPROVEN', 'T4', {
      kind: 'undo',
      safePart: { planId: 's1', verdict: 'SAFE', tier: 'T0', diff: [], dropped: [0] },
    });
    expect(previewScreen(unproven, names).controls[0]).toMatchObject({
      label: 'Just the part I can confirm',
      action: { kind: 'commit', planId: 'plan-1', safePartOnly: true },
    });
    expect(previewScreen(preview('SAFE', 'T2', { kind: 'undo' }), names).controls[0]?.label).toBe(
      'Yes, undo it',
    );
  });

  test('content that is none of ours draws nothing', () => {
    expect(screenFor({ entries: [] })).toBeNull();
    expect(screenFor(undefined)).toBeNull();
  });
});

describe('a zone’s temperature against a house rule', () => {
  const MIDNIGHT = '2027-01-16T00:00:00-06:00';
  /** Hourly samples from NOW; the last is at the end of the horizon, half an hour after the third. */
  const trace = (nominal: number[], pessimistic: number[], optimistic: number[]) =>
    ({
      start: NOW,
      end: MIDNIGHT,
      stepMinutes: 60,
      outdoorC: [0, 0, 0, 0],
      zonesC: {
        nominal: { house: [20, 20, 20, 20], garage: nominal },
        pessimistic: { house: [20, 20, 20, 20], garage: pessimistic },
        optimistic: { house: [20, 20, 20, 20], garage: optimistic },
      },
    }) satisfies TemperatureTrace;
  const freezes = trace([6, 5, 3.5, 2], [6, 4.5, 3, 1.5], [6, 5.5, 4.5, 3]);
  const rules: Temperatures['rules'] = {
    R3: {
      zone: 'garage',
      zoneName: 'Garage',
      minC: 4,
      maxC: null,
      heatedBy: ['garage_thermostat', 'plug_garage_freezer'],
    },
  };

  test('the temperatures come from the result’s _meta, and anything malformed is left out', () => {
    expect(
      temperaturesFrom({
        [TEMPERATURES_META_KEY]: { 'plan-1': freezes },
        [TEMPERATURE_RULES_META_KEY]: rules,
      }),
    ).toEqual({ traces: { 'plan-1': freezes }, rules });
    expect(
      temperaturesFrom({
        [TEMPERATURES_META_KEY]: { 'plan-1': { ...freezes, stepMinutes: 'fifteen' } },
        [TEMPERATURE_RULES_META_KEY]: { R3: { zone: 'garage', minC: '4' } },
      }),
    ).toEqual({ traces: {}, rules: {} });
    expect(temperaturesFrom(undefined)).toEqual({ traces: {}, rules: {} });
  });
});
