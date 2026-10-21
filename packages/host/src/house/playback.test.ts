import { describe, expect, test } from 'vitest';
import type { LiveDevice } from './looks.ts';
import {
  carriesPreview,
  changesBy,
  devicesAt,
  playhead,
  presenceAt,
  REPLAY_META_KEY,
  type Run,
  runsFrom,
  schedule,
  TEMPERATURES_META_KEY,
  type Trace,
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
});
