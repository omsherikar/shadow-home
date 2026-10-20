import { z } from 'zod';
import { capitalise, clock, count, midnights } from './format.ts';
import {
  type Preview,
  TEMPERATURE_RULES_META_KEY,
  TEMPERATURES_META_KEY,
  type TemperatureRule,
  type TemperatureTrace,
  type Violation,
} from './types.ts';

const RUNS = ['nominal', 'pessimistic', 'optimistic'] as const;

const zones = z.record(z.string(), z.array(z.number()));
const traceSchema = z.object({
  start: z.string(),
  end: z.string(),
  stepMinutes: z.number().positive(),
  outdoorC: z.array(z.number()),
  zonesC: z.object({ nominal: zones, pessimistic: zones, optimistic: zones }),
});
const ruleSchema = z.object({
  zone: z.string(),
  zoneName: z.string(),
  minC: z.number().nullable(),
  maxC: z.number().nullable(),
  heatedBy: z.array(z.string()),
});

/** What a tool result's `_meta` gives for drawing temperatures: traces by plan ID, and the rules. */
export interface Temperatures {
  traces: Record<string, TemperatureTrace>;
  rules: Record<string, TemperatureRule>;
}

export const NO_TEMPERATURES: Temperatures = { traces: {}, rules: {} };

/** The temperatures in a result's `_meta`. Anything malformed is left out, and the screen falls back. */
export function temperaturesFrom(meta: Record<string, unknown> | undefined): Temperatures {
  const traces = z.record(z.string(), traceSchema).safeParse(meta?.[TEMPERATURES_META_KEY]);
  const rules = z.record(z.string(), ruleSchema).safeParse(meta?.[TEMPERATURE_RULES_META_KEY]);
  return { traces: traces.success ? traces.data : {}, rules: rules.success ? rules.data : {} };
}

/** One plan's temperatures in the chart's zone, sample by sample. */
export interface Curve {
  /** "Your plan" or "With 2 fixes", when two curves share the chart. */
  label?: string;
  /** Within the rule's bounds in every run, by the check's own minute-by-minute reading. */
  holds: boolean;
  atMs: number[];
  /** The nominal run, and the lowest and highest of the three runs: the spread. */
  nominalC: number[];
  lowC: number[];
  highC: number[];
}

export interface TemperatureChart {
  /** The zone's name: "Garage". */
  zone: string;
  /** The rule drawn, by ID: "R3". */
  rule: string;
  minC: number | null;
  maxC: number | null;
  startMs: number;
  endMs: number;
  days: { atMs: number; label: string }[];
  /** The span of temperatures drawn: every run and the rule's bounds, with a margin. */
  fromC: number;
  toC: number;
  /** The plan first; then, if the screen offers one, the repaired plan. */
  curves: Curve[];
  /** Where the plan first breaks the rule. Blocked in the nominal run; unsure in another run only. */
  breaks?: { atMs: number; atC: number; label: string; tone: 'blocked' | 'unsure' };
  /** The chart in words, for a screen reader. */
  summary: string;
}

/**
 * The chart of a zone's temperature for a preview, when a temperature rule is involved: the plan
 * breaks it, or the plan (or the fix on offer) changes what heats the zone it watches. Undefined
 * otherwise, or without a usable trace, and the screen shows the timeline instead.
 */
export function temperatureChart(
  p: Preview,
  offered: 'repair' | 'safe_part' | null,
  temps: Temperatures,
): TemperatureChart | undefined {
  const own = temps.traces[p.planId];
  if (!own) return undefined;
  const repair = offered === 'repair' ? p.repair : null;
  const broken = p.violations
    .filter((v) => temps.rules[v.rule])
    .sort((a, b) => Date.parse(a.firstAt) - Date.parse(b.firstAt))[0];
  const touched = new Set([...p.diff, ...(repair?.diff ?? [])].map((r) => r.target));
  const ruleId =
    broken?.rule ??
    Object.keys(temps.rules).find((id) => temps.rules[id]?.heatedBy.some((d) => touched.has(d)));
  const rule = ruleId ? temps.rules[ruleId] : undefined;
  if (!ruleId || !rule) return undefined;

  const plan = curveOf(own, rule.zone, !broken);
  if (!plan) return undefined;
  const fixedTrace = repair ? temps.traces[repair.planId] : undefined;
  // A fix is offered only when its check is SAFE, so its curve holds.
  const fixed = fixedTrace ? curveOf(fixedTrace, rule.zone, true) : undefined;
  const curves = fixed
    ? [
        { ...plan, label: p.kind === 'undo' ? 'The undo' : 'Your plan' },
        { ...fixed, label: `With ${count(repair?.changes.length ?? 0, 'fix', 'fixes')}` },
      ]
    : [plan];

  const all = curves.flatMap((c) => [...c.lowC, ...c.highC]);
  const bounds = [rule.minC, rule.maxC].filter((b): b is number => b !== null);
  const lowest = Math.min(...all, ...bounds);
  const highest = Math.max(...all, ...bounds);
  const margin = Math.max(0.5, (highest - lowest) * 0.06);
  const startMs = plan.atMs[0] ?? 0;
  const endMs = plan.atMs.at(-1) ?? 0;
  const breaks = broken ? breakMark(broken, rule, own) : undefined;
  return {
    zone: rule.zoneName,
    rule: ruleId,
    minC: rule.minC,
    maxC: rule.maxC,
    startMs,
    endMs,
    days: midnights(own.start, own.end),
    fromC: lowest - margin,
    toC: highest + margin,
    curves,
    ...(breaks ? { breaks } : {}),
    summary: summary(rule, curves, breaks),
  };
}

function curveOf(t: TemperatureTrace, zone: string, holds: boolean): Curve | undefined {
  const runs = RUNS.map((run) => t.zonesC[run][zone]);
  const [nominal] = runs;
  const n = nominal?.length ?? 0;
  if (!nominal || n < 2 || runs.some((r) => r?.length !== n)) return undefined;
  const startMs = Date.parse(t.start);
  const endMs = Date.parse(t.end);
  if (!(endMs > startMs)) return undefined;
  const at = (i: number) => runs.map((r) => r?.[i] ?? Number.NaN);
  return {
    holds,
    atMs: nominal.map((_, i) =>
      i === n - 1 ? endMs : Math.min(endMs, startMs + i * t.stepMinutes * 60_000),
    ),
    nominalC: nominal,
    lowC: nominal.map((_, i) => Math.min(...at(i))),
    highC: nominal.map((_, i) => Math.max(...at(i))),
  };
}

/** The bound the rule broke, at the minute it broke, from the run that broke it. */
function breakMark(
  v: Violation,
  rule: TemperatureRule,
  t: TemperatureTrace,
): TemperatureChart['breaks'] {
  const atMs = Date.parse(v.firstAt);
  let atC = rule.minC ?? rule.maxC;
  if (rule.minC !== null && rule.maxC !== null) {
    const run = RUNS.find((r) => r === v.run) ?? 'nominal';
    const i = Math.round((atMs - Date.parse(t.start)) / (t.stepMinutes * 60_000));
    const c = t.zonesC[run][rule.zone]?.[Math.max(0, i)] ?? rule.minC;
    atC = c < (rule.minC + rule.maxC) / 2 ? rule.minC : rule.maxC;
  }
  if (atC === null || Number.isNaN(atMs)) return undefined;
  return {
    atMs,
    atC,
    label: clock(v.firstAt),
    tone: v.run === 'nominal' ? 'blocked' : 'unsure',
  };
}

/** "Garage temperature. Your plan: drops below 4 °C at Sat 10:37 PM. With 4 fixes: stays above 4 °C." */
function summary(
  rule: TemperatureRule,
  curves: Curve[],
  breaks: TemperatureChart['breaks'],
): string {
  const { minC, maxC } = rule;
  const holds =
    minC !== null && maxC !== null
      ? `stays between ${minC} and ${maxC} °C`
      : minC !== null
        ? `stays above ${minC} °C`
        : `stays below ${maxC} °C`;
  const broke = (b: NonNullable<typeof breaks>) => {
    const below = b.atC === minC;
    const way =
      b.tone === 'unsure'
        ? `may ${below ? 'drop below' : 'rise above'}`
        : below
          ? 'drops below'
          : 'rises above';
    return `${way} ${b.atC} °C at ${b.label}`;
  };
  const said = curves.map((c) => {
    const what = !c.holds && breaks ? broke(breaks) : holds;
    return c.label ? `${c.label}: ${what}.` : `${capitalise(what)}.`;
  });
  return `${rule.zoneName} temperature. ${said.join(' ')}`;
}
