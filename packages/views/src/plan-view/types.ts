/**
 * The parts of Shadow Home's tool results the plan view reads. The server's zod schemas
 * (packages/server/src/schemas.ts) are the source of truth; this is the view's side of them.
 */

export type Value = boolean | number | string;
export type Verdict = 'SAFE' | 'UNSAFE' | 'UNPROVEN';
export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

export interface Speech {
  headline: string;
  reason?: string;
  ask?: string;
}

export interface DiffRow {
  target: string;
  name: string;
  kind: 'device' | 'mode' | 'routine';
  attr: string;
  from: Value | null;
  to: Value;
  at: string;
  actionIndex: number;
  group?: string;
  reversibility: 'holdable' | 'compensable' | 'irreversible';
}

export interface TimelineEntry {
  at: string;
  /** "plan", a routine ID, or what scheduled the write. */
  source: string;
  actionIndex?: number;
  device: string;
  attr: string;
  from: Value | null;
  to: Value;
}

export interface Violation {
  rule: string;
  text: string;
  author: string;
  priority: string;
  refuse?: boolean;
  run: string;
  firstAt: string;
  cause?: TimelineEntry;
}

export interface RepairChange {
  rule: string;
  kind: 'leave_out' | 'nearest_value' | 'pause_routine' | 'drop_action' | 'add_action';
  actionIndex?: number;
  target: string;
  description: string;
}

export interface Alternative {
  planId: string;
  verdict: Verdict;
  tier: Tier;
  diff: DiffRow[];
}

export interface Preview {
  planId: string;
  kind: 'plan' | 'repair' | 'safe_part' | 'undo';
  verdict: Verdict;
  tier: Tier;
  speech: Speech;
  diff: DiffRow[];
  timeline: TimelineEntry[];
  violations: Violation[];
  invalid: { code: string; actionIndex: number | null; message: string }[];
  unknowns: string[];
  horizon: { start: string; end: string };
  repair: (Alternative & { changes: RepairChange[] }) | null;
  safePart: (Alternative & { dropped: number[] }) | null;
}

export interface Change {
  target: string;
  attr: string;
  from: Value | null;
  to: Value;
}

export interface Commit {
  status: 'committed' | 'needs_confirmation' | 'refused';
  reason?: string;
  planId: string;
  speech: Speech;
  applied: Change[];
  held: Change[];
  undoToken?: string;
  freshPreview?: Preview;
}

export interface Undo {
  status: 'preview' | 'nothing_to_undo';
  preview?: Preview;
  cannotUndo: { target: string; attr: string; why: string }[];
  notes: string[];
  speech: Speech;
}

/** Display names the server sends in the result's `_meta`, keyed by ID. */
export interface Names {
  devices: Record<string, { name: string; room: string }>;
  routines: Record<string, string>;
  members: Record<string, string>;
}

/** Where the server puts `Names` in a tool result's `_meta`. */
export const NAMES_META_KEY = 'shadow-home/names';

/**
 * Where the server puts approval tokens, plan ID to token, for the plans a result shows. Only the
 * screen reads `_meta`, so only a tap can approve a plan.
 */
export const APPROVAL_META_KEY = 'shadow-home/approval';

/**
 * The twin's temperatures over a plan's simulation, from the same runs that gave the verdict.
 * Sample `i` is at `start` plus `i × stepMinutes`, except the last, which is always at `end`.
 * Rounded to 0.1 °C. `outdoorC` is the forecast as the nominal run reads it.
 */
export interface TemperatureTrace {
  start: string;
  end: string;
  stepMinutes: number;
  outdoorC: number[];
  /** Run, then zone ("house", "garage"), then one temperature per sample. */
  zonesC: Record<'nominal' | 'pessimistic' | 'optimistic', Record<string, number[]>>;
}

/**
 * Where the server puts temperature traces, plan ID to `TemperatureTrace`, for each preview a
 * result carries: the plan's own and its repair's. They're only for drawing, so they stay out of
 * what the model reads.
 */
export const TEMPERATURES_META_KEY = 'shadow-home/temperatures';

/**
 * A house rule that keeps a zone's temperature within bounds at all times, as the check read it.
 * The screen draws a plan's temperatures against it. `heatedBy` names the devices that warm the
 * zone: its thermostat, and appliances that give off heat there.
 */
export interface TemperatureRule {
  zone: string;
  zoneName: string;
  minC: number | null;
  maxC: number | null;
  heatedBy: string[];
}

/** Where the server puts the temperature rules, rule ID to `TemperatureRule`, beside the traces. */
export const TEMPERATURE_RULES_META_KEY = 'shadow-home/temperature-rules';

/** Who a check took to be home from `from` to `to`: everyone, nobody, or the people named. */
export interface PresenceWindow {
  from: string;
  to: string;
  presence: 'nobody' | 'everyone' | { home: string[] };
}

/**
 * What the screen needs to replay a preview's run, from the same check that gave its verdict.
 * `presence` is who that check took to be home, window by window (where windows overlap, the last
 * one wins; outside them all, the household as it is). A repair's entry also carries its run,
 * which the result doesn't: the changes it makes over time, the rules it breaks and what it can't
 * establish.
 */
export interface Replay {
  presence: PresenceWindow[];
  timeline?: TimelineEntry[];
  violations?: Violation[];
  unknowns?: string[];
}
