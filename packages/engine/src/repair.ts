import { type Home, own, type Plan, type PlanAction, type Value } from '@shadow-home/twin';
import { ruleDevices } from './rules.ts';
import { formatIso, offsetMinutes, toMs } from './time.ts';
import { type CheckResult, check, type Reason, type Verdict } from './verdict.ts';

export type RepairKind = 'leave_out' | 'nearest_value' | 'pause_routine' | 'drop_action';

/** One change the repair search made, and the rule it answers. */
export interface Repair {
  rule: string;
  kind: RepairKind;
  /** The action it changes, in the original plan. Absent for an added routine pause. */
  actionIndex?: number;
  /** The device left out or given a new value, or the routine paused. */
  target: string;
  /** Short and specific: "keep plug_garage_freezer on", "garage_thermostat heat at 5 °C instead of off". */
  description: string;
}

export interface RepairResult {
  plan: Plan;
  result: CheckResult;
  repairs: Repair[];
}

export interface SafePart {
  plan: Plan;
  result: CheckResult;
  /** Actions of the original plan left out, by index. */
  dropped: number[];
}

/** Candidates for one rule are tried in order until it holds; this bounds the search. */
const MAX_ROUNDS = 12;
const MAX_VALUE_STEPS = 10;

type Edit =
  | { kind: 'leave_out'; devices: Set<string> }
  | { kind: 'replace'; set: Record<string, Value> }
  | { kind: 'drop' };

interface Candidate {
  repair: Repair;
  apply(edits: Map<number, Edit>, pauses: Map<string, string>): void;
}

interface Built {
  plan: Plan;
  /** For each action of the built plan, the original index it came from; -1 for an added pause. */
  origin: number[];
}

/**
 * Search for a SAFE version of the plan. For each broken rule (most important first), try in
 * order: leave the device out of the group action that reached it, move the value to the nearest
 * one that passes in 1 °C steps, pause the routine that broke it for as long as the plan lasts,
 * or drop the action. Each round applies one candidate per broken rule and checks the result
 * again; a rule that still breaks moves on to its next candidate. Returns null when the plan is
 * already SAFE or nothing improves it.
 */
export function repair(home: Home, plan: Plan, result: CheckResult): RepairResult | null {
  if (result.verdict === 'SAFE' || !result.lint.ok) return null;
  const edits = new Map<number, Edit>();
  const pauses = new Map<string, string>();
  const chosen = new Map<string, { key: string; queue: Candidate[]; current: Candidate }>();
  let built: Built = { plan, origin: plan.actions.map((_, i) => i) };
  let current = result;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const broken = current.reasons.filter(isRuleBreak);
    if (broken.length === 0) break;
    const nextEdits = new Map(edits);
    const nextPauses = new Map(pauses);
    let progressed = false;
    for (const reason of broken) {
      const cause = reason.cause;
      const origin =
        cause?.actionIndex === undefined ? -1 : (built.origin[cause.actionIndex] ?? -1);
      const key = cause ? `${cause.source}\u0000${origin}\u0000${cause.device}` : '';
      let state = chosen.get(reason.rule);
      if (!state || state.key !== key) {
        const queue = candidates(home, plan, reason, origin, current);
        const first = queue.shift();
        if (!first) continue;
        state = { key, queue, current: first };
      } else {
        const next = state.queue.shift();
        if (!next) continue;
        state.current = next;
      }
      chosen.set(reason.rule, state);
      state.current.apply(nextEdits, nextPauses);
      progressed = true;
    }
    if (!progressed) break;
    edits.clear();
    for (const [k, v] of nextEdits) edits.set(k, v);
    pauses.clear();
    for (const [k, v] of nextPauses) pauses.set(k, v);
    built = build(home, plan, edits, pauses);
    current = check(home, built.plan);
  }

  if (rank(current.verdict) >= rank(result.verdict)) return null;
  const repairs = [...chosen.values()]
    .map((s) => s.current.repair)
    .filter((r) => isApplied(r, edits, pauses));
  return { plan: built.plan, result: current, repairs };
}

/**
 * The plan's own actions minus the ones that break a rule or can't be checked, if what's left
 * is SAFE and not empty. Drops, in turn: actions lint rejects, actions that caused a broken
 * rule, and actions that write to a device an undecidable rule depends on.
 */
export function safePart(home: Home, plan: Plan, result: CheckResult): SafePart | null {
  if (result.verdict === 'SAFE') return null;
  const dropped = new Set<number>();
  let current = result;
  let kept = plan.actions.map((_, i) => i);
  for (let round = 0; round < 4; round++) {
    const implicated = implicatedActions(home, { ...plan, actions: kept.map(at(plan)) }, current);
    const fresh = implicated.map((i) => kept[i] as number).filter((i) => !dropped.has(i));
    if (fresh.length === 0) return null;
    for (const i of fresh) dropped.add(i);
    kept = kept.filter((i) => !dropped.has(i));
    if (kept.length === 0) return null;
    const subset: Plan = { ...plan, actions: kept.map(at(plan)) };
    current = check(home, subset);
    if (current.verdict === 'SAFE') {
      return { plan: subset, result: current, dropped: [...dropped].sort((a, b) => a - b) };
    }
  }
  return null;
}

function at(plan: Plan) {
  return (i: number) => plan.actions[i] as PlanAction;
}

function implicatedActions(home: Home, plan: Plan, result: CheckResult): number[] {
  const out = new Set<number>();
  for (const r of result.reasons) {
    if (r.kind === 'invalid' && r.actionIndex !== null) out.add(r.actionIndex);
    if ((r.kind === 'violation' || r.kind === 'not_robust') && r.cause?.source === 'plan') {
      if (r.cause.actionIndex !== undefined) out.add(r.cause.actionIndex);
    }
    if (r.kind === 'unknown' && r.rule) {
      const rule = home.rules.find((x) => x.id === r.rule);
      const devices = new Set(rule ? ruleDevices(home, rule) : []);
      plan.actions.forEach((a, i) => {
        if (!('set' in a)) return;
        const targets = 'group' in a ? (own(home.groups, a.group) ?? []) : [a.device];
        if (targets.some((d) => devices.has(d))) out.add(i);
      });
    }
  }
  return [...out].sort((a, b) => a - b);
}

type RuleBreak = Extract<Reason, { kind: 'violation' | 'not_robust' }>;

function isRuleBreak(r: Reason): r is RuleBreak {
  return r.kind === 'violation' || r.kind === 'not_robust';
}

function rank(v: Verdict): number {
  return v === 'SAFE' ? 0 : v === 'UNPROVEN' ? 1 : 2;
}

function candidates(
  home: Home,
  original: Plan,
  reason: RuleBreak,
  origin: number,
  result: CheckResult,
): Candidate[] {
  const cause = reason.cause;
  if (!cause) return [];
  const rule = reason.rule;

  if (cause.source !== 'plan') {
    const routine = home.routines.find((r) => r.id === cause.source);
    if (!routine) return [];
    const until = pauseEnd(home, original, result);
    const local = formatIso(toMs(until), offsetMinutes(home.home.utcOffset)).slice(0, 16);
    return [
      {
        repair: {
          rule,
          kind: 'pause_routine',
          target: routine.id,
          description: `pause routine ${routine.id} until ${local}`,
        },
        apply: (_edits, pauses) => {
          const had = pauses.get(routine.id);
          if (!had || toMs(had) < toMs(until)) pauses.set(routine.id, until);
        },
      },
    ];
  }

  const action = original.actions[origin];
  if (!action || !('set' in action)) {
    return origin >= 0 ? [drop(home, rule, origin, action)] : [];
  }
  const device = home.devices.find((d) => d.id === cause.device);
  const out: Candidate[] = [];
  if ('group' in action) {
    out.push({
      repair: {
        rule,
        kind: 'leave_out',
        actionIndex: origin,
        target: cause.device,
        description: keepPhrase(home, cause.device, cause.attr, action.group),
      },
      apply: (edits) => {
        const e = edits.get(origin);
        if (e?.kind === 'drop') return;
        const devices = new Set(e?.kind === 'leave_out' ? e.devices : []);
        devices.add(cause.device);
        edits.set(origin, { kind: 'leave_out', devices });
      },
    });
  } else if (device?.capabilities.heatingSetpointC?.type === 'number') {
    out.push(...nearestValues(home, rule, origin, action.set, device.id));
  }
  out.push(drop(home, rule, origin, action));
  return out;
}

/**
 * Thermostat values near what the plan asked for. "Off" becomes heat at the lowest setpoint
 * that passes, counting up from the minimum; a setpoint moves 1 °C at a time, up first.
 */
function nearestValues(
  home: Home,
  rule: string,
  origin: number,
  set: Record<string, Value>,
  deviceId: string,
): Candidate[] {
  const device = home.devices.find((d) => d.id === deviceId);
  const cap = device?.capabilities.heatingSetpointC;
  if (!device || cap?.type !== 'number') return [];
  const values: number[] = [];
  const asked = set.heatingSetpointC;
  const off = set.systemMode === 'off';
  if (off) {
    for (let v = Math.ceil(cap.min); v <= cap.max && values.length < MAX_VALUE_STEPS; v++) {
      values.push(v);
    }
  } else if (typeof asked === 'number') {
    for (let k = 1; values.length < MAX_VALUE_STEPS && k <= cap.max - cap.min; k++) {
      if (asked + k <= cap.max) values.push(asked + k);
      if (asked - k >= cap.min) values.push(asked - k);
    }
  } else {
    return [];
  }
  return values.map((v) => {
    const next: Record<string, Value> = off
      ? { ...set, systemMode: 'heat', heatingSetpointC: v }
      : { ...set, heatingSetpointC: v };
    const was = off ? 'off' : `${asked} °C`;
    const how = off ? `heat at ${v} °C` : `at ${v} °C`;
    return {
      repair: {
        rule,
        kind: 'nearest_value' as const,
        actionIndex: origin,
        target: deviceId,
        description: `${deviceId} ${how} instead of ${was}`,
      },
      apply: (edits: Map<number, Edit>) => {
        if (edits.get(origin)?.kind === 'drop') return;
        edits.set(origin, { kind: 'replace', set: next });
      },
    };
  });
}

function drop(home: Home, rule: string, origin: number, action: PlanAction | undefined): Candidate {
  const target =
    action && 'device' in action
      ? action.device
      : action && 'group' in action
        ? action.group
        : action && 'routine' in action
          ? action.routine
          : 'home';
  const first = action && 'set' in action ? Object.entries(action.set)[0] : undefined;
  const description =
    action && 'device' in action && first
      ? keepPhrase(home, action.device, first[0])
      : `leave out action ${origin}`;
  return {
    repair: { rule, kind: 'drop_action', actionIndex: origin, target, description },
    apply: (edits) => {
      edits.set(origin, { kind: 'drop' });
    },
  };
}

/** "keep plug_garage_freezer on", or "leave thermostat_main out of all_thermostats". */
function keepPhrase(home: Home, deviceId: string, attr: string, group?: string): string {
  const now = own(home.devices.find((d) => d.id === deviceId)?.state ?? {}, attr);
  if (attr === 'onOff' && typeof now === 'boolean') return `keep ${deviceId} ${now ? 'on' : 'off'}`;
  if (now !== undefined) return `keep ${deviceId} ${attr} at ${String(now)}`;
  return group ? `leave ${deviceId} out of ${group}` : `leave ${deviceId} ${attr} as it is`;
}

/** How long a routine pause has to last: the plan's end, else the last presence window, else the simulation's end. */
function pauseEnd(home: Home, plan: Plan, result: CheckResult): string {
  if (plan.context.planEnd) return plan.context.planEnd;
  const ends = (plan.context.presenceSchedule ?? []).map((w) => w.to);
  const last = ends.sort((a, b) => toMs(a) - toMs(b)).at(-1);
  return last ?? result.horizon.end ?? home.clock.now;
}

function isApplied(r: Repair, edits: Map<number, Edit>, pauses: Map<string, string>): boolean {
  if (r.kind === 'pause_routine') return pauses.has(r.target);
  const e = r.actionIndex === undefined ? undefined : edits.get(r.actionIndex);
  if (!e) return false;
  if (r.kind === 'drop_action') return e.kind === 'drop';
  if (r.kind === 'leave_out') return e.kind === 'leave_out' && e.devices.has(r.target);
  return e.kind === 'replace';
}

function build(
  home: Home,
  plan: Plan,
  edits: Map<number, Edit>,
  pauses: Map<string, string>,
): Built {
  const actions: PlanAction[] = [];
  const origin: number[] = [];
  plan.actions.forEach((action, i) => {
    const e = edits.get(i);
    if (e?.kind === 'drop') return;
    if (e?.kind === 'replace' && 'device' in action) {
      actions.push({ ...action, set: e.set });
      origin.push(i);
      return;
    }
    if (e?.kind === 'leave_out' && 'group' in action) {
      for (const device of own(home.groups, action.group) ?? []) {
        if (e.devices.has(device)) continue;
        actions.push(
          action.at ? { device, set: action.set, at: action.at } : { device, set: action.set },
        );
        origin.push(i);
      }
      return;
    }
    actions.push(action);
    origin.push(i);
  });
  for (const [routine, pauseUntil] of pauses) {
    actions.push({ routine, pauseUntil });
    origin.push(-1);
  }
  return { plan: { ...plan, actions }, origin };
}
