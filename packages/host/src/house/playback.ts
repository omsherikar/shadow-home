/**
 * Replaying a checked plan in the house: the engine's own run, played forward in seconds. Pure
 * functions over what the preview returned (its timeline, the rules it breaks, the temperature
 * trace); the house never simulates anything itself.
 */
import { z } from 'zod';
import { type Value, valueSchema } from './looks.ts';

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
      breaks: breaksOf(replay, changes, startMs),
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
 * own in the result, so it shows when the plan first acts (the dishwasher starting at 2 AM).
 */
function breaksOf(
  replay: Pick<Preview, 'violations' | 'unknowns'>,
  changes: Change[],
  startMs: number,
): Break[] {
  const firstAction = changes.find((c) => c.atMs > startMs)?.atMs ?? startMs;
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
