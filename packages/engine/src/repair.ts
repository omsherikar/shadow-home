import {
  type Home,
  own,
  type Plan,
  type PlanAction,
  type StateCond,
  type Value,
} from '@shadow-home/twin';
import { ruleDevices } from './rules.ts';
import { floorToMinute, formatIso, offsetMinutes, toMs } from './time.ts';
import { type CheckResult, check, type Reason, type Verdict } from './verdict.ts';

export type RepairKind =
  | 'leave_out'
  | 'nearest_value'
  | 'pause_routine'
  | 'drop_action'
  | 'add_action';

/** One change the repair search made, and the rule it answers. */
export interface Repair {
  rule: string;
  kind: RepairKind;
  /** The action it changes, in the original plan. Absent for an added pause or step. */
  actionIndex?: number;
  /** The device left out, given a new value or added a step, or the routine paused. */
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

/** Steps the search added, by device, attribute and time. */
type Adds = Map<string, PlanAction>;

interface Candidate {
  repair: Repair;
  apply(edits: Map<number, Edit>, pauses: Map<string, string>, adds: Adds): void;
  /** Whether this change is what the final plan actually has. */
  inEffect(edits: Map<number, Edit>, pauses: Map<string, string>, adds: Adds): boolean;
}

interface Built {
  plan: Plan;
  /** For each action of the built plan, the original index it came from; -1 for an added one. */
  origin: number[];
}

/**
 * Search for a SAFE version of the plan. For each broken rule (most important first), try in
 * order: leave the device out of the group action that reached it, move the value to the nearest
 * one that passes in 1 °C steps, pause the routine that broke it for as long as the plan lasts,
 * or drop the action; last, add the step the rule asks for (lock the door, turn the heater off)
 * at the moment it would break, which is the only fix when the plan simply left a step out. Each
 * round applies one candidate per broken rule and checks the result again; a rule that still
 * breaks moves on to its next candidate. Returns null when the plan is already SAFE or nothing
 * improves it.
 */
export function repair(home: Home, plan: Plan, result: CheckResult): RepairResult | null {
  if (result.verdict === 'SAFE' || !result.lint.ok) return null;
  const edits = new Map<number, Edit>();
  const pauses = new Map<string, string>();
  const adds: Adds = new Map();
  const chosen = new Map<string, { key: string; queue: Candidate[]; current: Candidate }>();
  const tried: Candidate[] = [];
  let built: Built = { plan, origin: plan.actions.map((_, i) => i) };
  let current = result;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const broken = current.reasons.filter(isRuleBreak);
    if (broken.length === 0) break;
    const nextEdits = new Map(edits);
    const nextPauses = new Map(pauses);
    const nextAdds: Adds = new Map(adds);
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
      state.current.apply(nextEdits, nextPauses, nextAdds);
      tried.push(state.current);
      progressed = true;
    }
    if (!progressed) break;
    edits.clear();
    for (const [k, v] of nextEdits) edits.set(k, v);
    pauses.clear();
    for (const [k, v] of nextPauses) pauses.set(k, v);
    adds.clear();
    for (const [k, v] of nextAdds) adds.set(k, v);
    built = build(home, plan, edits, pauses, adds);
    current = check(home, built.plan);
  }

  if (rank(current.verdict) >= rank(result.verdict)) return null;
  // Every change the final plan actually carries, in the order it was made: a candidate a later
  // one replaced (or a rule's earlier fix when its cause moved) is listed only if it still holds.
  const seen = new Set<string>();
  const repairs = tried
    .filter((c) => c.inEffect(edits, pauses, adds))
    .map((c) => c.repair)
    .filter((r) => !seen.has(r.description) && seen.add(r.description));
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
  // Nothing changed toward the break (everyone leaving tipped it): only an added step can help.
  if (!cause) return addedSteps(home, original, reason, result);
  const rule = reason.rule;

  if (cause.source !== 'plan') {
    const routine = home.routines.find((r) => r.id === cause.source);
    if (!routine) return addedSteps(home, original, reason, result);
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
        inEffect: (_edits, pauses) => pauses.get(routine.id) === until,
      },
      ...addedSteps(home, original, reason, result),
    ];
  }

  const action = original.actions[origin];
  if (!action || !('set' in action)) {
    return [
      ...(origin >= 0 ? [drop(rule, origin, action, original, result, home)] : []),
      ...addedSteps(home, original, reason, result),
    ];
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
        description: keepPhrase(
          cause.device,
          cause.attr,
          stateAt(home, original, result, cause.device, cause.attr, whenMs(action, original), true),
          action.group,
        ),
      },
      apply: (edits) => {
        const e = edits.get(origin);
        if (e?.kind === 'drop') return;
        const devices = new Set(e?.kind === 'leave_out' ? e.devices : []);
        devices.add(cause.device);
        edits.set(origin, { kind: 'leave_out', devices });
      },
      inEffect: (edits) => {
        const e = edits.get(origin);
        return e?.kind === 'leave_out' && e.devices.has(cause.device);
      },
    });
  } else if (device?.capabilities.heatingSetpointC?.type === 'number') {
    out.push(...nearestValues(home, rule, origin, action.set, device.id));
  }
  out.push(drop(rule, origin, action, original, result, home));
  out.push(...addedSteps(home, original, reason, result));
  return out;
}

/**
 * The steps a broken rule asks for, each as an action at the moment it first breaks: the states
 * "always" and "within_after" need that don't hold then, and for "never_when" the opposite of each
 * forbidden state that holds then (every light still on, not just the first). Only states the
 * rule names exactly, on attributes the device can be set to: true or false, or one of two values.
 */
function addedSteps(home: Home, plan: Plan, reason: RuleBreak, result: CheckResult): Candidate[] {
  const rule = home.rules.find((r) => r.id === reason.rule);
  if (!rule) return [];
  const atMs = toMs(reason.firstAt);
  const holds = (s: StateCond) => {
    const v = stateAt(home, plan, result, s.device, s.attr, atMs);
    return v !== undefined && ('eq' in s ? v === s.eq : v !== s.neq);
  };
  const writes: { device: string; attr: string; value: Value }[] = [];
  const need = (s: StateCond, want: boolean) => {
    const value = valueMaking(home, s, want);
    if (value !== undefined) writes.push({ device: s.device, attr: s.attr, value });
  };
  switch (rule.template) {
    case 'always':
      if (!holds(rule.params.state)) need(rule.params.state, true);
      break;
    case 'within_after':
      for (const s of rule.params.ensure) if (!holds(s)) need(s, true);
      break;
    case 'never_when': {
      const x = rule.params.x;
      for (const part of 'any' in x ? x.any : [x]) {
        if (isState(part) && holds(part)) need(part, false);
      }
      break;
    }
  }
  const at = atMs > toMs(plan.context.now) ? reason.firstAt : undefined;
  return writes.map(({ device, attr, value }) => {
    const key = `${device}\u0000${attr}\u0000${at ?? ''}`;
    const action: PlanAction = at
      ? { device, set: { [attr]: value }, at }
      : { device, set: { [attr]: value } };
    return {
      repair: {
        rule: rule.id,
        kind: 'add_action' as const,
        target: device,
        description: `${stepPhrase(device, attr, value)}${at ? ` at ${at.slice(11, 16)}` : ''}`,
      },
      apply: (_edits: Map<number, Edit>, _pauses: Map<string, string>, adds: Adds) => {
        adds.set(key, action);
      },
      inEffect: (_edits: Map<number, Edit>, _pauses: Map<string, string>, adds: Adds) =>
        JSON.stringify(adds.get(key)) === JSON.stringify(action),
    };
  });
}

function isState(c: object): c is StateCond {
  return 'device' in c && ('eq' in c || 'neq' in c);
}

/** The value that makes a state hold (or not), if the device can be set to exactly one. */
function valueMaking(home: Home, s: StateCond, want: boolean): Value | undefined {
  const cap = own(home.devices.find((d) => d.id === s.device)?.capabilities ?? {}, s.attr);
  if (!cap) return undefined;
  const named = 'eq' in s ? s.eq : s.neq;
  if ('eq' in s === want) return named;
  if (cap.type === 'boolean' && typeof named === 'boolean') return !named;
  if (cap.type === 'enum' && cap.values.length === 2) return cap.values.find((v) => v !== named);
  return undefined;
}

/**
 * A device's value at a moment of the plan's nominal run: its starting state, then each change up
 * to that minute (with `before`, only changes earlier than it).
 */
function stateAt(
  home: Home,
  plan: Plan,
  result: CheckResult,
  device: string,
  attr: string,
  atMs: number,
  before = false,
): Value | undefined {
  let value =
    own(own(plan.context.stateOverrides ?? {}, device)?.state ?? {}, attr) ??
    own(home.devices.find((d) => d.id === device)?.state ?? {}, attr);
  for (const e of result.timeline) {
    const t = toMs(e.at);
    if (e.device === device && e.attr === attr && (before ? t < atMs : t <= atMs)) value = e.to;
  }
  return value;
}

/** "turn plug_bedroom_space_heater off", "lock front_door_lock". */
function stepPhrase(device: string, attr: string, value: Value): string {
  if (attr === 'onOff' && typeof value === 'boolean')
    return `turn ${device} ${value ? 'on' : 'off'}`;
  if (attr === 'lockState' && (value === 'LOCKED' || value === 'UNLOCKED')) {
    return `${value === 'LOCKED' ? 'lock' : 'unlock'} ${device}`;
  }
  return `set ${device} ${attr} to ${String(value)}`;
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
      inEffect: (edits: Map<number, Edit>) => {
        const e = edits.get(origin);
        return e?.kind === 'replace' && JSON.stringify(e.set) === JSON.stringify(next);
      },
    };
  });
}

function drop(
  rule: string,
  origin: number,
  action: PlanAction | undefined,
  plan: Plan,
  result: CheckResult,
  home: Home,
): Candidate {
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
      ? keepPhrase(
          action.device,
          first[0],
          stateAt(home, plan, result, action.device, first[0], whenMs(action, plan), true),
        )
      : `leave out action ${origin}`;
  return {
    repair: { rule, kind: 'drop_action', actionIndex: origin, target, description },
    apply: (edits) => {
      edits.set(origin, { kind: 'drop' });
    },
    inEffect: (edits) => edits.get(origin)?.kind === 'drop',
  };
}

/**
 * "keep plug_garage_freezer on", or "leave thermostat_main out of all_thermostats". `before` is the
 * device's value just before the action, which a step the search added may have set.
 */
function keepPhrase(
  deviceId: string,
  attr: string,
  before: Value | undefined,
  group?: string,
): string {
  if (attr === 'onOff' && typeof before === 'boolean') {
    return `keep ${deviceId} ${before ? 'on' : 'off'}`;
  }
  if (before !== undefined) return `keep ${deviceId} ${attr} at ${String(before)}`;
  return group ? `leave ${deviceId} out of ${group}` : `leave ${deviceId} ${attr} as it is`;
}

/**
 * The minute an action runs: its time, else the plan's now, floored to the minute as the
 * simulation steps it (decision 14). Otherwise a now with seconds would count the action's own
 * change, recorded at the start of its minute, as already done before it.
 */
function whenMs(action: PlanAction, plan: Plan): number {
  return floorToMinute(toMs('at' in action && action.at ? action.at : plan.context.now));
}

/** How long a routine pause has to last: the plan's end, else the last presence window, else the simulation's end. */
function pauseEnd(home: Home, plan: Plan, result: CheckResult): string {
  if (plan.context.planEnd) return plan.context.planEnd;
  const ends = (plan.context.presenceSchedule ?? []).map((w) => w.to);
  const last = ends.sort((a, b) => toMs(a) - toMs(b)).at(-1);
  return last ?? result.horizon.end ?? home.clock.now;
}

function build(
  home: Home,
  plan: Plan,
  edits: Map<number, Edit>,
  pauses: Map<string, string>,
  adds: Adds,
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
  for (const step of adds.values()) {
    actions.push(step);
    origin.push(-1);
  }
  return { plan: { ...plan, actions }, origin };
}
