/**
 * Replaying a checked plan in the house: the engine's own run, played forward in seconds. Pure
 * functions over what the preview returned (its timeline, the rules it breaks, the temperature
 * trace); the house never simulates anything itself.
 */
import { z } from 'zod';
import type { HouseLayout } from './layout.ts';
import { type LiveDevice, mix, type Value, valueSchema } from './looks.ts';

export interface Change {
  atMs: number;
  device: string;
  attr: string;
  to: Value;
}

/** A moment worth stopping on: a rule breaking, or something the twin couldn't establish. */
export interface Break {
  /** A rule broken, a rule that may break, a reading that can't be trusted, or a rule's hours starting. */
  kind: 'violation' | 'not_robust' | 'unknown' | 'guard';
  atMs: number;
  /** The rule's ID and words, and whose rule it is. Unknowns have only words. */
  rule?: string;
  text: string;
  author?: string;
  /** The device to look at: the cause of the break, or the sensor that can't be read. */
  device?: string;
}

// What a tool result carries, as far as the house reads it. A result is checked, not trusted: one
// the house can't read plays nothing, and the house shows the home as it is.
/** A time the house can place: anything Date.parse can't read would stop the clock. */
const instant = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'not a time');
const verdictSchema = z.enum(['SAFE', 'UNSAFE', 'UNPROVEN']);
const entrySchema = z.object({
  at: instant,
  /** "plan" for the plan's own actions; a routine's ID, or what scheduled it, otherwise. */
  source: z.string().optional(),
  device: z.string(),
  attr: z.string(),
  to: valueSchema,
});
const violationSchema = z.object({
  rule: z.string(),
  text: z.string(),
  author: z.string(),
  run: z.enum(['nominal', 'pessimistic', 'optimistic']),
  firstAt: instant,
  cause: z.object({ device: z.string() }).optional(),
});
const previewSchema = z.object({
  planId: z.string(),
  verdict: verdictSchema,
  timeline: z.array(entrySchema),
  violations: z.array(violationSchema),
  unknowns: z.array(z.string()),
  horizon: z
    .object({
      // The home's clock reads in the offset the run starts in.
      start: instant.refine((s) => /[+-]\d{2}:\d{2}$/.test(s), 'no UTC offset'),
      end: instant,
    })
    .refine((h) => Date.parse(h.end) > Date.parse(h.start), 'ends before it starts'),
  repair: z
    .object({ planId: z.string(), verdict: verdictSchema, changes: z.array(z.unknown()) })
    .nullable(),
});
const presenceSchema = z.union([
  z.enum(['nobody', 'everyone']),
  z.object({ home: z.array(z.string()) }),
]);
const replaySchema = z.object({
  presence: z.array(z.object({ from: instant, to: instant, presence: presenceSchema })),
  timeline: z.array(entrySchema).optional(),
  violations: z.array(violationSchema).optional(),
  unknowns: z.array(z.string()).optional(),
});
const series = z.array(z.number());
const traceSchema = z.object({
  start: instant,
  end: instant,
  stepMinutes: z.number().positive(),
  outdoorC: series,
  zonesC: z.object({
    nominal: z.record(z.string(), series),
    pessimistic: z.record(z.string(), series),
    optimistic: z.record(z.string(), series),
  }),
});

export const TEMPERATURES_META_KEY = 'shadow-home/temperatures';
export const TEMPERATURE_RULES_META_KEY = 'shadow-home/temperature-rules';
export const REPLAY_META_KEY = 'shadow-home/replay';

const metaSchema = z.object({
  [TEMPERATURES_META_KEY]: z.record(z.string(), traceSchema).optional(),
  [TEMPERATURE_RULES_META_KEY]: z
    .record(
      z.string(),
      z.object({ zone: z.string(), minC: z.number().nullable(), maxC: z.number().nullable() }),
    )
    .optional(),
  [REPLAY_META_KEY]: z.record(z.string(), replaySchema).optional(),
});

/** A zone's temperatures over a run: the three runs, one sample every `stepMinutes`. */
export type Trace = z.infer<typeof traceSchema>;
export type Presence = z.infer<typeof presenceSchema>;
type Preview = z.infer<typeof previewSchema>;
type Replay = z.infer<typeof replaySchema>;

/** One run to play: the plan as asked, or the plan with the fixes. */
export interface Run {
  planId: string;
  /** "Your plan", "With 4 fixes". */
  label: string;
  tone: 'plan' | 'fixed';
  verdict: 'SAFE' | 'UNSAFE' | 'UNPROVEN';
  startMs: number;
  endMs: number;
  /** The home's UTC offset, "-06:00", for showing its clock. */
  offset: string;
  changes: Change[];
  breaks: Break[];
  trace: Trace | null;
  /** Each zone's temperature limits from the house rules (the garage: 4 °C at least). */
  limits: Record<string, { minC: number | null; maxC: number | null }>;
  /** Who the check took to be home, window by window; outside them, the household as it is. */
  presence: { fromMs: number; toMs: number; who: Presence }[];
}

const MINUTE_MS = 60_000;

/**
 * The runs a tool result asks the house to play: a preview's plan and, when it offers one, the
 * plan with its fixes. An undo's preview and a fresh preview after a stale plan ID count too.
 * Who's home comes from the server's replay of each, as its check took it, never from what a
 * call asked: a fresh preview or an undo carries no presence of its own. A result or screen data
 * the house can't read plays nothing.
 */
export function runsFrom(
  tool: string,
  structured: Record<string, unknown> | undefined,
  rawMeta: Record<string, unknown> | undefined,
): Run[] {
  const parsedPreview = previewSchema.safeParse(previewIn(tool, structured));
  const parsedMeta = metaSchema.safeParse(rawMeta ?? {});
  if (!parsedPreview.success || !parsedMeta.success) return [];
  const preview = parsedPreview.data;
  const meta = parsedMeta.data;
  const traces = meta[TEMPERATURES_META_KEY] ?? {};
  const replays = meta[REPLAY_META_KEY] ?? {};
  const limits: Run['limits'] = {};
  for (const r of Object.values(meta[TEMPERATURE_RULES_META_KEY] ?? {})) {
    limits[r.zone] = { minC: r.minC, maxC: r.maxC };
  }
  // Without who the check took to be home, the house would have to guess; it doesn't.
  const own = replays[preview.planId];
  if (!own) return [];
  const startMs = Date.parse(preview.horizon.start);
  const run = (
    planId: string,
    label: string,
    tone: Run['tone'],
    verdict: Run['verdict'],
    replay: Pick<Preview, 'timeline' | 'violations' | 'unknowns'>,
    presence: Replay['presence'],
  ): Run => {
    const changes = replay.timeline
      .map((e) => ({ atMs: Date.parse(e.at), device: e.device, attr: e.attr, to: e.to }))
      .sort((a, b) => a.atMs - b.atMs);
    return {
      planId,
      label,
      tone,
      verdict,
      startMs,
      endMs: Date.parse(preview.horizon.end),
      offset: preview.horizon.start.slice(-6),
      changes,
      breaks: breaksOf(replay, startMs),
      trace: traces[planId] ?? null,
      limits,
      presence: presence.map((w) => ({
        fromMs: Date.parse(w.from),
        toMs: Date.parse(w.to),
        who: w.presence,
      })),
    };
  };
  const runs = [run(preview.planId, 'Your plan', 'plan', preview.verdict, preview, own.presence)];
  const fix = preview.repair;
  const fixed = fix ? replays[fix.planId] : undefined;
  if (fix && fixed?.timeline && fixed.violations && fixed.unknowns) {
    const n = fix.changes.length;
    runs.push(
      run(
        fix.planId,
        `With ${n} ${n === 1 ? 'fix' : 'fixes'}`,
        'fixed',
        fix.verdict,
        { timeline: fixed.timeline, violations: fixed.violations, unknowns: fixed.unknowns },
        fixed.presence,
      ),
    );
  }
  return runs;
}

/** Whether a tool result carries a preview: the house plays it, or shows the home as it is. */
export function carriesPreview(tool: string, sc: Record<string, unknown> | undefined): boolean {
  return previewIn(tool, sc) !== undefined;
}

function previewIn(tool: string, sc: Record<string, unknown> | undefined): unknown {
  if (!sc) return undefined;
  if (tool === 'preview_plan') return sc;
  if (tool === 'undo') return sc.preview;
  if (tool === 'commit_plan') return sc.freshPreview;
  return undefined;
}

/**
 * Rule breaks at their times, and what the twin couldn't establish. An unknown has no time of its
 * own in the result, so it shows when the plan first acts (the dishwasher starting at 2 AM), or
 * at the start where the plan changes nothing itself (the leaving check).
 */
function breaksOf(
  replay: Pick<Preview, 'timeline' | 'violations' | 'unknowns'>,
  startMs: number,
): Break[] {
  // The plan's own first action, never a routine's: a plan with none of its own (nothing to do,
  // or writes that change nothing) is checked from the start, so that's where it stops.
  const planAt = replay.timeline
    .filter((e) => e.source === 'plan')
    .map((e) => Date.parse(e.at))
    .filter((ms) => ms >= startMs)
    .sort((a, b) => a - b)[0];
  const firstAction = planAt ?? startMs;
  const broken: Break[] = replay.violations.map((v) => ({
    kind: v.run === 'nominal' ? 'violation' : 'not_robust',
    atMs: Date.parse(v.firstAt),
    rule: v.rule,
    text: v.text,
    author: v.author,
    ...(v.cause?.device ? { device: v.cause.device } : {}),
  }));
  const unknown: Break[] = replay.unknowns.map((text) => {
    // "dishwasher_latch: battery 4% is under 15%" names the sensor first.
    const device = /^([a-z0-9_]+):/.exec(text)?.[1];
    return { kind: 'unknown', atMs: firstAction, text, ...(device ? { device } : {}) };
  });
  return [...broken, ...unknown].sort((a, b) => a.atMs - b.atMs);
}

export interface Timing {
  /** Real milliseconds for the whole sweep from now to the end, without the stops. */
  sweepMs: number;
  /** Real milliseconds to stop on each moment worth looking at. */
  holdMs: number;
}

/** One stretch of a run's playback: sweeping between two home times, or holding on one. */
interface Segment {
  realMs: number;
  fromMs: number;
  toMs: number;
  /** While holding: the breaks at this moment. */
  hold?: Break[];
}

export interface Schedule {
  totalMs: number;
  segments: Segment[];
}

/**
 * How a run plays in real time: a sweep from its start to its end, stopping at every moment a
 * rule breaks (breaks in the same minute share one stop).
 */
export function schedule(run: Run, timing: Timing): Schedule {
  const span = Math.max(MINUTE_MS, run.endMs - run.startMs);
  const stops = new Map<number, Break[]>();
  for (const b of run.breaks) {
    const at = Math.min(Math.max(b.atMs, run.startMs), run.endMs);
    stops.set(at, [...(stops.get(at) ?? []), b]);
  }
  const segments: Segment[] = [];
  let at = run.startMs;
  for (const [stop, held] of [...stops].sort((a, b) => a[0] - b[0])) {
    if (stop > at) {
      segments.push({ realMs: (timing.sweepMs * (stop - at)) / span, fromMs: at, toMs: stop });
    }
    segments.push({ realMs: timing.holdMs, fromMs: stop, toMs: stop, hold: held });
    at = stop;
  }
  if (run.endMs > at) {
    segments.push({
      realMs: (timing.sweepMs * (run.endMs - at)) / span,
      fromMs: at,
      toMs: run.endMs,
    });
  }
  return { totalMs: segments.reduce((t, s) => t + s.realMs, 0), segments };
}

/** Where a run's playback is after `realMs`: the home time, and the breaks being held on. */
export function playhead(s: Schedule, realMs: number): { homeMs: number; held: Break[] } {
  let left = Math.max(0, realMs);
  for (const seg of s.segments) {
    if (left < seg.realMs) {
      const t = seg.realMs === 0 ? 1 : left / seg.realMs;
      return { homeMs: seg.fromMs + (seg.toMs - seg.fromMs) * t, held: seg.hold ?? [] };
    }
    left -= seg.realMs;
  }
  const last = s.segments.at(-1);
  return { homeMs: last?.toMs ?? 0, held: [] };
}

/** Each device's state at a home time: how it started, with every change up to then applied. */
export function devicesAt(start: LiveDevice[], changes: Change[], atMs: number): LiveDevice[] {
  const touched = new Map<string, Record<string, Value>>();
  for (const c of changes) {
    if (c.atMs > atMs) break;
    if (c.device === 'home') continue;
    const before = start.find((d) => d.id === c.device)?.state ?? {};
    touched.set(c.device, { ...(touched.get(c.device) ?? before), [c.attr]: c.to });
  }
  return start.map((d) => (touched.has(d.id) ? { ...d, state: touched.get(d.id) ?? d.state } : d));
}

/** How many of a run's changes have happened by a home time: the state changes only when this does. */
export function changesBy(changes: Change[], atMs: number): number {
  let n = 0;
  while (n < changes.length && (changes[n]?.atMs ?? Number.POSITIVE_INFINITY) <= atMs) n++;
  return n;
}

/** Who is home at a home time: the presence windows the plan was checked with, else as now. */
export function presenceAt(
  now: Record<string, 'home' | 'away'>,
  windows: Run['presence'],
  atMs: number,
): Record<string, 'home' | 'away'> {
  let who: Presence | undefined;
  for (const w of windows) if (w.fromMs <= atMs && atMs < w.toMs) who = w.who;
  if (who === undefined) return now;
  const out: Record<string, 'home' | 'away'> = {};
  for (const member of Object.keys(now)) {
    out[member] =
      who === 'everyone'
        ? 'home'
        : who === 'nobody'
          ? 'away'
          : who.home.includes(member)
            ? 'home'
            : 'away';
  }
  return out;
}

export interface Temperatures {
  outdoorC: number;
  /** Each zone as the expected (nominal) run has it. */
  zonesC: Record<string, number>;
  /** Each zone's spread across the three runs. */
  bandC: Record<string, { low: number; high: number }>;
}

/** The trace's temperatures at a home time, between its samples. */
export function temperaturesAt(trace: Trace, atMs: number): Temperatures {
  const start = Date.parse(trace.start);
  const end = Date.parse(trace.end);
  const n = trace.outdoorC.length;
  const step = trace.stepMinutes * MINUTE_MS;
  // Sample i sits at start + i steps, except the last, which is always at the end.
  const timeOf = (i: number) => (i === n - 1 ? end : start + i * step);
  const t = Math.min(Math.max(atMs, start), end);
  let i = Math.min(n - 2, Math.max(0, Math.floor((t - start) / step)));
  while (i < n - 2 && timeOf(i + 1) < t) i++;
  const t0 = timeOf(i);
  const t1 = timeOf(i + 1);
  const k = n < 2 || t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const at = (series: number[]) => {
    const a = series[i] ?? series[0] ?? 0;
    const b = series[i + 1] ?? a;
    return a + (b - a) * k;
  };
  const zonesC: Record<string, number> = {};
  const bandC: Record<string, { low: number; high: number }> = {};
  for (const [zone, series] of Object.entries(trace.zonesC.nominal)) {
    zonesC[zone] = at(series);
    const runs = Object.values(trace.zonesC).map((z) => at(z[zone] ?? series));
    bandC[zone] = { low: Math.min(...runs), high: Math.max(...runs) };
  }
  return { outdoorC: at(trace.outdoorC), zonesC, bandC };
}

/** A room's tint for its temperature: icy blue near freezing, through neutral, to warm orange. */
export function temperatureColor(c: number): string {
  const stops: [number, string][] = [
    [0, '#dff1ff'],
    [4, '#8cc2ee'],
    [11, '#c9c2b8'],
    [17, '#f0b878'],
    [22, '#ec8a3c'],
  ];
  if (c <= (stops[0]?.[0] ?? 0)) return stops[0]?.[1] ?? '#ffffff';
  for (let i = 1; i < stops.length; i++) {
    const [c1, hex1] = stops[i] as [number, string];
    const [c0, hex0] = stops[i - 1] as [number, string];
    if (c <= c1) return mix(hex0, hex1, (c - c0) / (c1 - c0));
  }
  return stops.at(-1)?.[1] ?? '#ffffff';
}

/** The room a device is in, by where the layout puts it (the porch light: the nearest room). */
export function roomOf(layout: HouseLayout, device: string): string | undefined {
  const p = layout.devices.find((d) => d.device === device);
  if (!p) return undefined;
  let best: { id: string; distance: number } | undefined;
  for (const r of layout.rooms) {
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
    const dz = Math.max(r.z - p.z, 0, p.z - (r.z + r.depth));
    const distance = Math.hypot(dx, dz);
    if (!best || distance < best.distance) best = { id: r.id, distance };
  }
  return best?.id;
}

/** "Sat 10:37 PM" for an instant, read in the home's own UTC offset ("-06:00"). */
export function homeClock(ms: number, offset: string): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const minutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const local = new Date(ms + minutes * MINUTE_MS);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local.getUTCDay()];
  const h = local.getUTCHours();
  const mi = local.getUTCMinutes();
  return `${day} ${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** An instant as ISO 8601 in the home's offset, for the light outside at that time. */
export function homeIso(ms: number, offset: string): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const minutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return `${new Date(ms + minutes * MINUTE_MS).toISOString().slice(0, 19)}${offset}`;
}

/** How long each part of a show takes, in real milliseconds. */
export interface ShowTiming {
  plan: Timing;
  fixed: Timing;
  /** A pause on the plan's end before the fixes play. */
  pauseMs: number;
  /** The clock winding back to the start for the fixes. */
  rewindMs: number;
}

export const SHOW_TIMING: ShowTiming = {
  plan: { sweepMs: 7000, holdMs: 1300 },
  fixed: { sweepMs: 5000, holdMs: 1000 },
  pauseMs: 900,
  rewindMs: 700,
};

/** Where a show is: which run, at what home time, what it's stopped on, and whether it's over. */
export interface Moment {
  run: number;
  homeMs: number;
  held: Break[];
  rewinding: boolean;
  done: boolean;
}

/**
 * A show plays the plan, pauses on its end, winds the clock back and plays the plan with its
 * fixes. With `only`, it plays that one run. After the end it stays on the last moment.
 */
export function moment(runs: Run[], timing: ShowTiming, realMs: number, only?: number): Moment {
  const order = only === undefined ? runs.map((_, i) => i) : [only];
  let left = Math.max(0, realMs);
  for (const [k, i] of order.entries()) {
    const run = runs[i];
    if (!run) continue;
    const s = schedule(run, i === 0 ? timing.plan : timing.fixed);
    if (left < s.totalMs) {
      const p = playhead(s, left);
      return { run: i, homeMs: p.homeMs, held: p.held, rewinding: false, done: false };
    }
    left -= s.totalMs;
    const next = runs[order[k + 1] ?? -1];
    if (!next) return { run: i, homeMs: run.endMs, held: [], rewinding: false, done: true };
    if (left < timing.pauseMs) {
      return { run: i, homeMs: run.endMs, held: [], rewinding: false, done: false };
    }
    left -= timing.pauseMs;
    if (left < timing.rewindMs) {
      const t = left / timing.rewindMs;
      const back = run.endMs + (next.startMs - run.endMs) * (1 - (1 - t) ** 2);
      return { run: i, homeMs: back, held: [], rewinding: true, done: false };
    }
    left -= timing.rewindMs;
  }
  const last = runs[order.at(-1) ?? 0];
  return {
    run: order.at(-1) ?? 0,
    homeMs: last?.endMs ?? 0,
    held: [],
    rewinding: false,
    done: true,
  };
}

/** How long a whole show takes to play, in real milliseconds. */
export function showLength(runs: Run[], timing: ShowTiming): number {
  return runs.reduce(
    (total, run, i) =>
      total +
      schedule(run, i === 0 ? timing.plan : timing.fixed).totalMs +
      (i > 0 ? timing.pauseMs + timing.rewindMs : 0),
    0,
  );
}

/** A new house rule's sample day: the hours it guards, on the device it guards. */
export interface Guard {
  device: string;
  /** Minutes after midnight, home time; `to` before `from` runs past midnight. */
  windows: { from: number; to: number }[];
  /** The rule read back, as the server words it. */
  words: string;
}

const addedSchema = z.object({ status: z.literal('added'), readBack: z.string().optional() });
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const hoursSchema = z.object({ from: clockTime, to: clockTime });
/** Deeper than any compiled rule nests; a call that goes further shows nothing. */
const RULE_DEPTH = 32;

/**
 * What a new house rule guards, from the compiled rule the call carried (the demo's rules come
 * compiled): the device it names and the times of day it applies. Plain words, compiled on the
 * server, carry no rule in the call, so there is nothing to show; nor is there for a result or a
 * rule the house can't read.
 */
export function guardFrom(
  tool: string,
  args: Record<string, unknown>,
  structured: Record<string, unknown> | undefined,
): Guard | null {
  if (tool !== 'add_house_rule') return null;
  const added = addedSchema.safeParse(structured);
  if (!added.success) return null;
  const devices: string[] = [];
  const windows: Guard['windows'] = [];
  let tooDeep = false;
  const walk = (v: unknown, depth: number) => {
    if (depth > RULE_DEPTH) tooDeep = true;
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.device === 'string') devices.push(o.device);
      const hours = hoursSchema.safeParse(o.time);
      if (hours.success) {
        windows.push({ from: minuteOfDay(hours.data.from), to: minuteOfDay(hours.data.to) });
      }
      for (const x of Object.values(o)) walk(x, depth + 1);
    }
  };
  walk(args.rule, 0);
  const device = devices[0];
  if (tooDeep || !device || windows.length === 0) return null;
  return { device, windows, words: added.data.readBack ?? '' };
}

function minuteOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Whether a guard applies at a home time ("2027-01-15T23:10:00-06:00"). */
export function guarding(guard: Guard, iso: string): boolean {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return false;
  const t = Number(m[1]) * 60 + Number(m[2]);
  return guard.windows.some((w) =>
    w.from <= w.to ? w.from <= t && t < w.to : t >= w.from || t < w.to,
  );
}

/**
 * A rule's sample day as a run to play: the next 24 hours from now, with nothing changing, and a
 * stop when the guarded hours begin.
 */
export function sampleDay(guard: Guard, nowIso: string): Run {
  const startMs = Date.parse(nowIso);
  const offset = nowIso.slice(-6);
  const endMs = startMs + 24 * 60 * MINUTE_MS;
  // The first time in the day the guard starts.
  let begins = startMs;
  for (let t = startMs; t <= endMs; t += MINUTE_MS) {
    if (guarding(guard, homeIso(t, offset))) {
      begins = t;
      break;
    }
  }
  return {
    planId: 'rule',
    label: 'Sample day',
    tone: 'fixed',
    verdict: 'SAFE',
    startMs,
    endMs,
    offset,
    changes: [],
    breaks: [{ kind: 'guard', atMs: begins, text: guard.words, device: guard.device }],
    trace: null,
    limits: {},
    presence: [],
  };
}

/** A zone's temperature over a run, drawn small: SVG paths in a box of the given size. */
export interface Chart {
  /** The expected run's line. */
  line: string;
  /** The spread of the three runs, as a filled shape. */
  band: string;
  /** Where the zone's lower limit sits, if it has one. */
  limitY: number | null;
  /** Where on the chart a home time falls, left to right. */
  x(ms: number): number;
  /** The temperatures the chart spans, bottom to top. */
  rangeC: [number, number];
}

export function chartOf(
  trace: Trace,
  zone: string,
  limit: { minC: number | null } | undefined,
  width: number,
  height: number,
): Chart {
  const start = Date.parse(trace.start);
  const end = Date.parse(trace.end);
  const step = trace.stepMinutes * MINUTE_MS;
  const nominal = trace.zonesC.nominal[zone] ?? [];
  const runs = Object.values(trace.zonesC).map((z) => z[zone] ?? nominal);
  const low = nominal.map((_, i) => Math.min(...runs.map((r) => r[i] ?? Number.NaN)));
  const high = nominal.map((_, i) => Math.max(...runs.map((r) => r[i] ?? Number.NaN)));
  const values = [
    ...low,
    ...high,
    ...(limit?.minC === null || limit?.minC === undefined ? [] : [limit.minC]),
  ];
  const bottom = Math.floor(Math.min(...values) - 1);
  const top = Math.ceil(Math.max(...values) + 1);
  const timeOf = (i: number) => (i === nominal.length - 1 ? end : start + i * step);
  const x = (ms: number) =>
    ((Math.min(Math.max(ms, start), end) - start) / Math.max(1, end - start)) * width;
  const y = (c: number) => height - ((c - bottom) / Math.max(1, top - bottom)) * height;
  const point = (i: number, c: number) => `${x(timeOf(i)).toFixed(1)},${y(c).toFixed(1)}`;
  const line = nominal.map((c, i) => `${i === 0 ? 'M' : 'L'}${point(i, c)}`).join(' ');
  const upper = high.map((c, i) => `${i === 0 ? 'M' : 'L'}${point(i, c)}`);
  const lower = low.map((c, i) => `L${point(i, c)}`).reverse();
  return {
    line,
    band: `${[...upper, ...lower].join(' ')} Z`,
    limitY: limit?.minC === null || limit?.minC === undefined ? null : y(limit.minC),
    x,
    rangeC: [bottom, top],
  };
}
