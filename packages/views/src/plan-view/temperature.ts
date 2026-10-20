import { z } from 'zod';
import {
  TEMPERATURE_RULES_META_KEY,
  TEMPERATURES_META_KEY,
  type TemperatureRule,
  type TemperatureTrace,
} from './types.ts';

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
}
