import { describe, expect, test } from 'vitest';
import { houseLayout as layout } from './layout.ts';
import type { LiveDevice } from './looks.ts';
import {
  carriesPreview,
  changesBy,
  chartOf,
  devicesAt,
  guardFrom,
  guarding,
  homeClock,
  homeIso,
  moment,
  playhead,
  presenceAt,
  REPLAY_META_KEY,
  type Run,
  roomOf,
  runsFrom,
  type ShowTiming,
  sampleDay,
  schedule,
  showLength,
  TEMPERATURE_RULES_META_KEY,
  TEMPERATURES_META_KEY,
  type Trace,
  temperatureColor,
  temperatureStrength,
  temperaturesAt,
} from './playback.ts';

const at = (local: string) => Date.parse(`${local}-06:00`);
const FRI = '2027-01-15T17:45:00-06:00';
const SUN = '2027-01-17T18:00:00-06:00';

const preview = {
  planId: 'plan',
  verdict: 'UNSAFE',
  timeline: [
    {
      at: '2027-01-16T07:00:00-06:00',
      source: 'coffee_at_7',
      device: 'plug_coffee_maker',
      attr: 'onOff',
      from: false,
      to: true,
    },
    {
      at: FRI,
      source: 'plan',
      device: 'plug_garage_freezer',
      attr: 'onOff',
      from: true,
      to: false,
    },
    { at: FRI, source: 'plan', device: 'home', attr: 'mode', from: 'home', to: 'away' },
  ],
  violations: [
    {
      rule: 'R3',
      text: 'Don’t let the garage pipes freeze.',
      author: 'om',
      run: 'nominal',
      firstAt: '2027-01-16T22:37:00-06:00',
      cause: { device: 'garage_thermostat' },
    },
    {
      rule: 'R1',
      text: 'Never turn off the garage freezer.',
      author: 'om',
      run: 'nominal',
      firstAt: FRI,
      cause: { device: 'plug_garage_freezer' },
    },
  ],
  unknowns: [],
  horizon: { start: FRI, end: SUN },
  repair: { planId: 'fixed', verdict: 'SAFE', changes: [{}, {}, {}, {}] },
};
const trace: Trace = {
  start: FRI,
  end: SUN,
  stepMinutes: 15,
  outdoorC: [2, 1, 0],
  zonesC: {
    nominal: { house: [20, 19, 18], garage: [9, 6, 3] },
    pessimistic: { house: [20, 18, 17], garage: [9, 5, 1] },
    optimistic: { house: [20, 19.5, 19], garage: [9, 7, 5] },
  },
};
// Who each check took to be home: nobody from 6 PM Friday to the end, then (for the fixes, which
// keep Om home on Sunday afternoon) Om alone.
const nobody = [{ from: '2027-01-15T18:00:00-06:00', to: SUN, presence: 'nobody' }];
const omBack = [
  ...nobody,
  { from: '2027-01-17T14:00:00-06:00', to: SUN, presence: { home: ['om'] } },
];
const meta = {
  [TEMPERATURES_META_KEY]: { plan: trace },
  [REPLAY_META_KEY]: {
    plan: { presence: nobody },
    fixed: { presence: omBack, timeline: [], violations: [], unknowns: [] },
  },
};
/** Screen data with only the plan's own replay: who its check took to be home. */
const planOnly = { [REPLAY_META_KEY]: { plan: { presence: [] } } };

describe('runs from a tool result', () => {
  test('a preview with fixes plays the plan, then the plan with its fixes', () => {
    const runs = runsFrom('preview_plan', preview, meta);
    expect(runs.map((r) => [r.planId, r.label, r.tone, r.verdict])).toEqual([
      ['plan', 'Your plan', 'plan', 'UNSAFE'],
      ['fixed', 'With 4 fixes', 'fixed', 'SAFE'],
    ]);
    const [plan] = runs as [Run];
    expect([plan.startMs, plan.endMs, plan.offset]).toEqual([
      Date.parse(FRI),
      Date.parse(SUN),
      '-06:00',
    ]);
    // Changes in time order; breaks in time order, each with the device that caused it.
    expect(plan.changes.map((c) => c.device)).toEqual([
      'plug_garage_freezer',
      'home',
      'plug_coffee_maker',
    ]);
    expect(plan.breaks.map((b) => [b.rule, b.device])).toEqual([
      ['R1', 'plug_garage_freezer'],
      ['R3', 'garage_thermostat'],
    ]);
    expect(plan.trace).toEqual(trace);
    expect(runs[1]?.trace).toBeNull();
  });

  test('who’s home in each run is who its own check took to be home', () => {
    const [plan, fixed] = runsFrom('preview_plan', preview, meta) as [Run, Run];
    expect(plan.presence).toEqual([
      { fromMs: at('2027-01-15T18:00:00'), toMs: Date.parse(SUN), who: 'nobody' },
    ]);
    expect(fixed.presence).toEqual([
      { fromMs: at('2027-01-15T18:00:00'), toMs: Date.parse(SUN), who: 'nobody' },
      { fromMs: at('2027-01-17T14:00:00'), toMs: Date.parse(SUN), who: { home: ['om'] } },
    ]);
  });

  test('without who the check took to be home, nothing plays: the house doesn’t guess', () => {
    expect(runsFrom('preview_plan', preview, {})).toEqual([]);
    expect(
      runsFrom('preview_plan', preview, {
        [REPLAY_META_KEY]: { fixed: meta[REPLAY_META_KEY].fixed },
      }),
    ).toEqual([]);
  });

  test('without the fix’s run in _meta, only the plan plays', () => {
    expect(runsFrom('preview_plan', preview, planOnly).map((r) => r.planId)).toEqual(['plan']);
    const presenceOnly = {
      [REPLAY_META_KEY]: { plan: { presence: nobody }, fixed: { presence: nobody } },
    };
    expect(runsFrom('preview_plan', preview, presenceOnly).map((r) => r.planId)).toEqual(['plan']);
  });

  test('a result or screen data the house can’t read plays nothing, rather than throw', () => {
    const replays = meta[REPLAY_META_KEY];
    const unreadable: [string, Record<string, unknown>, Record<string, unknown>][] = [
      [
        'a fix’s timeline that isn’t a list',
        preview,
        { [REPLAY_META_KEY]: { ...replays, fixed: { ...replays.fixed, timeline: 'soon' } } },
      ],
      [
        'presence that isn’t a list',
        preview,
        { [REPLAY_META_KEY]: { ...replays, plan: { presence: 'nobody' } } },
      ],
      [
        'a presence window with no time',
        preview,
        { [REPLAY_META_KEY]: { plan: { presence: [{ to: SUN, presence: 'nobody' }] } } },
      ],
      [
        'a trace with a run missing',
        preview,
        { ...meta, [TEMPERATURES_META_KEY]: { plan: { ...trace, zonesC: { nominal: {} } } } },
      ],
      ['replays that aren’t a map', preview, { [REPLAY_META_KEY]: [1, 2] }],
      [
        'a change at a time that isn’t one',
        { ...preview, timeline: [{ ...preview.timeline[0], at: 'soon' }] },
        meta,
      ],
      ['a run that ends before it starts', { ...preview, horizon: { start: SUN, end: FRI } }, meta],
      [
        'a start with no UTC offset',
        { ...preview, horizon: { start: '2027-01-15T23:45:00Z', end: SUN } },
        meta,
      ],
      ['a verdict it doesn’t know', { ...preview, verdict: 'MAYBE' }, meta],
    ];
    for (const [why, result, screen] of unreadable) {
      expect(() => runsFrom('preview_plan', result, screen), why).not.toThrow();
      expect(runsFrom('preview_plan', result, screen), why).toEqual([]);
    }
  });

  test('what the twin can’t establish shows at the sensor, when the plan first acts', () => {
    const unproven = {
      ...preview,
      verdict: 'UNPROVEN',
      violations: [],
      unknowns: ['dishwasher_latch: battery 4% is under 15%'],
      timeline: [
        {
          at: '2027-01-16T02:00:00-06:00',
          source: 'plan',
          device: 'dishwasher',
          attr: 'onOff',
          from: false,
          to: true,
        },
      ],
      repair: null,
    };
    const [run] = runsFrom('preview_plan', unproven, planOnly);
    expect(run?.breaks).toEqual([
      {
        kind: 'unknown',
        atMs: at('2027-01-16T02:00:00'),
        text: 'dishwasher_latch: battery 4% is under 15%',
        device: 'dishwasher_latch',
      },
    ]);
  });

  test('a routine that fires before the plan acts doesn’t take its stop', () => {
    const unproven = {
      ...preview,
      verdict: 'UNPROVEN',
      violations: [],
      unknowns: ['dishwasher_latch: battery 4% is under 15%'],
      timeline: [
        {
          at: '2027-01-15T23:00:00-06:00',
          source: 'porch_light',
          device: 'light_porch',
          attr: 'onOff',
          from: true,
          to: false,
        },
        {
          at: '2027-01-16T02:00:00-06:00',
          source: 'plan',
          device: 'dishwasher',
          attr: 'onOff',
          from: false,
          to: true,
        },
      ],
      repair: null,
    };
    const [run] = runsFrom('preview_plan', unproven, planOnly);
    expect(run?.breaks.map((b) => [b.kind, b.atMs])).toEqual([
      ['unknown', at('2027-01-16T02:00:00')],
    ]);
  });

  test('a plan that acts at once shows what the twin can’t establish at once, not at a later change', () => {
    const now = {
      ...preview,
      verdict: 'UNPROVEN',
      violations: [],
      unknowns: ['dishwasher_latch: battery 4% is under 15%'],
      timeline: [
        { at: FRI, source: 'plan', device: 'dishwasher', attr: 'onOff', from: false, to: true },
        {
          at: '2027-01-16T07:00:00-06:00',
          source: 'coffee_at_7',
          device: 'plug_coffee_maker',
          attr: 'onOff',
          from: false,
          to: true,
        },
      ],
      repair: null,
    };
    const [run] = runsFrom('preview_plan', now, planOnly);
    expect(run?.breaks.map((b) => [b.kind, b.atMs])).toEqual([['unknown', Date.parse(FRI)]]);
  });

  describe('where the plan does nothing itself, what the twin can’t establish shows at the start', () => {
    const door = 'front_door_contact: battery 3% is under 15%';
    const routines = [
      {
        at: '2027-01-15T23:00:00-06:00',
        source: 'porch_light',
        device: 'light_porch',
        attr: 'onOff',
        from: true,
        to: false,
      },
      {
        at: '2027-01-16T07:00:00-06:00',
        source: 'coffee_at_7',
        device: 'plug_coffee_maker',
        attr: 'onOff',
        from: false,
        to: true,
      },
    ];
    const unproven = (timeline: unknown[]) => ({
      ...preview,
      verdict: 'UNPROVEN',
      violations: [],
      unknowns: [door],
      timeline,
      repair: null,
    });
    const unknownAt = (timeline: unknown[]) =>
      runsFrom('preview_plan', unproven(timeline), planOnly)[0]?.breaks.map((b) => [
        b.kind,
        b.atMs,
        b.device,
      ]);

    test('an empty plan (the leaving check) stops at the start, not at a routine', () => {
      // Only routines change anything: the plan is the house as it stands as someone leaves.
      expect(unknownAt(routines)).toEqual([['unknown', Date.parse(FRI), 'front_door_contact']]);
    });

    test('so does a plan whose writes change nothing, which the timeline leaves out', () => {
      // "Main thermostat to 20 °C" when it's already 20: no entry of the plan's own.
      expect(unknownAt(routines.slice(1))).toEqual([
        ['unknown', Date.parse(FRI), 'front_door_contact'],
      ]);
    });

    test('a plan that acts more than once stops at its first action', () => {
      const act = (at: string) => ({
        at,
        source: 'plan',
        device: 'dishwasher',
        attr: 'onOff',
        from: false,
        to: true,
      });
      expect(
        unknownAt([
          ...routines,
          act('2027-01-16T02:00:00-06:00'),
          act('2027-01-16T01:00:00-06:00'),
        ]),
      ).toEqual([['unknown', at('2027-01-16T01:00:00'), 'front_door_contact']]);
    });

    test('the plan with its fixes stops at its own first action too', () => {
      const fixedMeta = {
        [REPLAY_META_KEY]: {
          plan: { presence: [] },
          fixed: {
            presence: [],
            timeline: [
              ...routines,
              {
                at: '2027-01-16T02:00:00-06:00',
                source: 'plan',
                device: 'dishwasher',
                attr: 'onOff',
                from: false,
                to: true,
              },
            ],
            violations: [],
            unknowns: [door],
          },
        },
      };
      const [, fixed] = runsFrom(
        'preview_plan',
        { ...unproven(routines), repair: { planId: 'fixed', verdict: 'UNPROVEN', changes: [{}] } },
        fixedMeta,
      );
      expect(fixed?.breaks.map((b) => [b.kind, b.atMs])).toEqual([
        ['unknown', at('2027-01-16T02:00:00')],
      ]);
    });
  });

  test('an undo’s preview and a fresh preview after a stale plan ID play too; other results don’t', () => {
    expect(runsFrom('undo', { status: 'preview', preview }, planOnly)).toHaveLength(1);
    expect(
      runsFrom('commit_plan', { status: 'refused', freshPreview: preview }, planOnly),
    ).toHaveLength(1);
    expect(runsFrom('commit_plan', { status: 'committed' }, planOnly)).toEqual([]);
    expect(runsFrom('get_home_state', { now: FRI }, planOnly)).toEqual([]);
    expect(runsFrom('preview_plan', undefined, planOnly)).toEqual([]);
  });

  test('a result that carries a preview is one the house either plays or steps back from', () => {
    expect(carriesPreview('preview_plan', preview)).toBe(true);
    expect(carriesPreview('undo', { status: 'preview', preview })).toBe(true);
    expect(carriesPreview('undo', { status: 'nothing_to_undo' })).toBe(false);
    expect(carriesPreview('commit_plan', { status: 'refused', freshPreview: preview })).toBe(true);
    expect(carriesPreview('commit_plan', { status: 'committed' })).toBe(false);
    expect(carriesPreview('get_home_state', { now: FRI })).toBe(false);
  });
});

describe('the schedule', () => {
  const [run] = runsFrom('preview_plan', preview, meta) as [Run];
  const s = schedule(run, { sweepMs: 8000, holdMs: 1000 });

  test('sweeps the whole run in the sweep time, plus a stop at each break', () => {
    expect(s.totalMs).toBeCloseTo(8000 + 2 * 1000, 6);
    expect(playhead(s, 0)).toEqual({ homeMs: run.startMs, held: [run.breaks[0]] });
    expect(playhead(s, s.totalMs).homeMs).toBe(run.endMs);
  });

  test('home time only moves forward, and holds still at a break', () => {
    let last = Number.NEGATIVE_INFINITY;
    for (let real = 0; real <= s.totalMs; real += 50) {
      const { homeMs } = playhead(s, real);
      expect(homeMs).toBeGreaterThanOrEqual(last);
      last = homeMs;
    }
    const r3 = run.breaks[1];
    const stop = s.segments.find((seg) => seg.hold?.includes(r3 as never));
    expect(stop?.fromMs).toBe(at('2027-01-16T22:37:00'));
    expect(stop?.toMs).toBe(stop?.fromMs);
  });

  test('breaks in the same minute share one stop', () => {
    const r1 = run.breaks[0] as Run['breaks'][number];
    const twice = { ...run, breaks: [...run.breaks, { ...r1, rule: 'R2' }] };
    const shared = schedule(twice, { sweepMs: 8000, holdMs: 1000 });
    expect(shared.segments.filter((seg) => seg.hold).map((seg) => seg.hold?.length)).toEqual([
      2, 1,
    ]);
  });
});

describe('the house at a moment', () => {
  const start: LiveDevice[] = [
    { id: 'plug_garage_freezer', kind: 'plug', state: { onOff: true } },
    { id: 'plug_coffee_maker', kind: 'plug', state: { onOff: false } },
  ];
  const [run] = runsFrom('preview_plan', preview, meta) as [Run];

  test('devices start as they were and change at their times; mode changes touch no device', () => {
    const state = (local: string) =>
      Object.fromEntries(
        devicesAt(start, run.changes, at(local)).map((d) => [d.id, d.state.onOff]),
      );
    expect(devicesAt(start, run.changes, run.startMs - 1)).toEqual(start);
    expect(state('2027-01-15T17:45:00')).toEqual({
      plug_garage_freezer: false,
      plug_coffee_maker: false,
    });
    expect(state('2027-01-16T07:00:00')).toEqual({
      plug_garage_freezer: false,
      plug_coffee_maker: true,
    });
    expect(changesBy(run.changes, at('2027-01-16T06:59:00'))).toBe(2);
    expect(changesBy(run.changes, at('2027-01-16T07:00:00'))).toBe(3);
  });

  test('people follow the presence windows the plan was checked with', () => {
    const now = { om: 'home', maya: 'home', sam: 'home' } as const;
    expect(presenceAt(now, run.presence, at('2027-01-15T17:50:00'))).toEqual(now);
    expect(presenceAt(now, run.presence, at('2027-01-16T12:00:00'))).toEqual({
      om: 'away',
      maya: 'away',
      sam: 'away',
    });
    const some = [{ fromMs: 0, toMs: Number.POSITIVE_INFINITY, who: { home: ['sam'] } }];
    expect(presenceAt(now, some, 1)).toEqual({ om: 'away', maya: 'away', sam: 'home' });
    expect(presenceAt(now, run.presence, Date.parse(SUN))).toEqual(now);
  });

  test('temperatures follow the trace between samples, with the three runs’ spread', () => {
    const start15 = Date.parse(FRI);
    expect(temperaturesAt(trace, start15)).toEqual({
      outdoorC: 2,
      zonesC: { house: 20, garage: 9 },
      bandC: { house: { low: 20, high: 20 }, garage: { low: 9, high: 9 } },
    });
    const half = temperaturesAt(trace, start15 + 7.5 * 60_000);
    expect(half.zonesC.garage).toBeCloseTo(7.5, 6);
    expect(half.bandC.garage).toEqual({ low: 7, high: 8 });
    // The last sample is at the end, however long the last gap is.
    expect(temperaturesAt(trace, Date.parse(SUN)).zonesC.garage).toBe(3);
    expect(temperaturesAt(trace, Date.parse(SUN) + 1).zonesC.garage).toBe(3);
  });
});

describe('drawing it', () => {
  test('rooms go from frost through cyan and clear to warm orange', () => {
    expect(temperatureColor(-5)).toBe('#f2feff');
    expect(temperatureColor(-2)).toBe('#f2feff');
    expect(temperatureColor(30)).toBe('#ec8a3c');
    const red = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
    expect(red(temperatureColor(20))).toBeGreaterThan(red(temperatureColor(4)));
    // A comfortable room is barely tinted; the further from comfortable, the stronger.
    expect(temperatureStrength(15)).toBeLessThan(0.1);
    expect(temperatureStrength(4)).toBeGreaterThan(temperatureStrength(10));
    expect(temperatureStrength(22)).toBeGreaterThan(temperatureStrength(18));
  });

  test('a device is in the room the layout puts it in; the porch light in the nearest', () => {
    expect(roomOf(layout, 'plug_garage_freezer')).toBe('garage');
    expect(roomOf(layout, 'plug_coffee_maker')).toBe('kitchen');
    expect(roomOf(layout, 'light_porch')).toBe('living_room');
    expect(roomOf(layout, 'no_such_device')).toBeUndefined();
  });

  test('the clock reads in the home’s own offset', () => {
    expect(homeClock(at('2027-01-16T22:37:00'), '-06:00')).toBe('Sat 10:37 PM');
    expect(homeClock(at('2027-01-17T00:05:00'), '-06:00')).toBe('Sun 12:05 AM');
    expect(homeIso(at('2027-01-16T22:37:00'), '-06:00')).toBe('2027-01-16T22:37:00-06:00');
  });
});

describe('a show', () => {
  const runs = runsFrom('preview_plan', preview, meta);
  const timing: ShowTiming = {
    plan: { sweepMs: 8000, holdMs: 1000 },
    fixed: { sweepMs: 4000, holdMs: 1000 },
    pauseMs: 500,
    rewindMs: 500,
  };
  const plan = runs[0] as Run;
  const fixed = runs[1] as Run;
  const planMs = schedule(plan, timing.plan).totalMs;

  test('plays the plan, pauses on its end, winds back, then plays the plan with its fixes', () => {
    expect(moment(runs, timing, 0)).toMatchObject({ run: 0, homeMs: plan.startMs, done: false });
    expect(moment(runs, timing, planMs + 100)).toMatchObject({
      run: 0,
      homeMs: plan.endMs,
      rewinding: false,
    });
    const back = moment(runs, timing, planMs + 500 + 250);
    expect(back.rewinding).toBe(true);
    expect(back.homeMs).toBeLessThan(plan.endMs);
    expect(back.homeMs).toBeGreaterThan(fixed.startMs);
    expect(moment(runs, timing, planMs + 1000)).toMatchObject({ run: 1, homeMs: fixed.startMs });
  });

  test('its length is when it ends, and after the end it stays on the last moment', () => {
    const total = showLength(runs, timing);
    expect(total).toBeCloseTo(planMs + 1000 + schedule(fixed, timing.fixed).totalMs, 6);
    expect(moment(runs, timing, total - 1).done).toBe(false);
    expect(moment(runs, timing, total)).toMatchObject({ run: 1, homeMs: fixed.endMs, done: true });
    expect(moment(runs, timing, Number.POSITIVE_INFINITY).done).toBe(true);
  });

  test('one run can be played on its own', () => {
    expect(moment(runs, timing, 0, 1)).toMatchObject({ run: 1, homeMs: fixed.startMs });
    expect(moment(runs, timing, Number.POSITIVE_INFINITY, 0)).toMatchObject({
      run: 0,
      homeMs: plan.endMs,
      done: true,
    });
  });

  test('each zone’s limit from the house rules comes with the runs', () => {
    const withRules = runsFrom('preview_plan', preview, {
      ...meta,
      [TEMPERATURE_RULES_META_KEY]: {
        R3: { zone: 'garage', zoneName: 'Garage', minC: 4, maxC: null, heatedBy: [] },
      },
    });
    expect(withRules[0]?.limits).toEqual({ garage: { minC: 4, maxC: null } });
  });
});

describe('a new house rule’s sample day', () => {
  const args = {
    text: 'Never unlock the front door between 10 PM and 6 AM unless I’m home.',
    rule: {
      template: 'never_when',
      params: {
        x: { device: 'front_door_lock', attr: 'lockState', eq: 'UNLOCKED' },
        when: {
          all: [
            { time: { from: '22:00', to: '06:00' } },
            { not: { presence: { member: 'om', is: 'home' } } },
          ],
        },
      },
    },
  };
  const added = {
    status: 'added',
    readBack: 'Between 10 PM and 6 AM the front door stays locked unless Om is home.',
  };

  test('guards the device the compiled rule names, in the hours it names', () => {
    expect(guardFrom('add_house_rule', args, added)).toEqual({
      device: 'front_door_lock',
      windows: [{ from: 22 * 60, to: 6 * 60 }],
      words: added.readBack,
    });
  });

  test('shows nothing for words the server compiled, or a rule that wasn’t added', () => {
    expect(guardFrom('add_house_rule', { text: args.text }, added)).toBeNull();
    expect(guardFrom('add_house_rule', args, { status: 'unclear' })).toBeNull();
    expect(guardFrom('preview_plan', args, added)).toBeNull();
  });

  test('shows nothing for a result or a rule it can’t read, rather than throw', () => {
    const hours = (time: unknown) => ({
      ...args,
      rule: { ...args.rule, params: { ...args.rule.params, when: { time } } },
    });
    let deep: unknown = args.rule;
    for (let i = 0; i < 20; i++) deep = { all: [deep] };
    const cases: [string, Record<string, unknown>, Record<string, unknown> | undefined][] = [
      ['words read back that aren’t words', args, { status: 'added', readBack: 5 }],
      ['no result', args, undefined],
      ['an hour past the day', hours({ from: '25:00', to: '06:00' }), added],
      ['hours that aren’t times', hours({ from: 22, to: 6 }), added],
      ['a rule that isn’t one', { ...args, rule: 'never' }, added],
      ['a rule nested past any compiled one', { ...args, rule: deep }, added],
    ];
    for (const [why, call, result] of cases) {
      expect(() => guardFrom('add_house_rule', call, result), why).not.toThrow();
      expect(guardFrom('add_house_rule', call, result), why).toBeNull();
    }
  });

  test('its hours run past midnight', () => {
    const guard = guardFrom('add_house_rule', args, added);
    if (!guard) throw new Error('no guard');
    const at = (hhmm: string) => guarding(guard, `2027-01-15T${hhmm}:00-06:00`);
    expect([at('21:59'), at('22:00'), at('23:30'), at('05:59'), at('06:00'), at('12:00')]).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  test('plays the next 24 hours and stops when the guarded hours begin', () => {
    const guard = guardFrom('add_house_rule', args, added);
    if (!guard) throw new Error('no guard');
    const day = sampleDay(guard, FRI);
    expect(day.endMs - day.startMs).toBe(24 * 3_600_000);
    expect(day.breaks).toEqual([
      {
        kind: 'guard',
        atMs: at('2027-01-15T22:00:00'),
        text: added.readBack,
        device: 'front_door_lock',
      },
    ]);
  });
});

describe('the zone chart', () => {
  const chart = chartOf(trace, 'garage', { minC: 4 }, 200, 80);

  test('runs across the whole width, with the expected line inside the three runs’ spread', () => {
    expect(chart.line.startsWith('M0.0,')).toBe(true);
    expect(chart.line).toContain('L200.0,');
    expect(chart.band.endsWith('Z')).toBe(true);
    expect(chart.x(Date.parse(FRI))).toBe(0);
    expect(chart.x(Date.parse(SUN))).toBe(200);
  });

  test('draws the rule’s limit inside the chart, in the temperatures it spans', () => {
    expect(chart.rangeC[0]).toBeLessThanOrEqual(1);
    expect(chart.rangeC[1]).toBeGreaterThanOrEqual(9);
    expect(chart.limitY).toBeGreaterThan(0);
    expect(chart.limitY).toBeLessThan(80);
    expect(chartOf(trace, 'garage', undefined, 200, 80).limitY).toBeNull();
  });
});
