import { type Device, type Home, hasOwn, own, type Plan, type Value } from '@shadow-home/twin';
import { clockMinutes, formatClock, localMinuteOfDay, offsetMinutes, toMs } from './time.ts';
import { type DeviceWrite, expandWrites } from './writes.ts';

export type HygieneCode =
  | 'conflicting_writes'
  | 'repeated_write'
  | 'missing_reversal'
  | 'routine_collision'
  | 'conflicting_pauses'
  | 'repeated_pause';

export interface HygieneFinding {
  stage: 'hygiene';
  code: HygieneCode;
  /** The plan actions involved, ascending. */
  actionIndexes: number[];
  /** The device and attribute involved; absent for findings about routine pauses. */
  device?: string;
  attr?: string;
  /** The routine involved, for routine_collision and the pause findings. */
  routine?: string;
  message: string;
}

const MINUTE_MS = 60_000;

/**
 * Stage 2. Is the plan well-formed as a sequence? Flags writes to one attribute at one time
 * (conflicting or repeated), hazardous changes nothing in the plan undoes, writes that land
 * on the same minute as a home routine writing a different value, and routines paused more
 * than once (the last pause in plan order wins). "One time" means one minute, the simulation's
 * step. Findings are warnings: they never change the verdict on their own.
 */
export function hygiene(home: Home, plan: Plan): HygieneFinding[] {
  const writes = expandWrites(home, plan);
  const devices = new Map(home.devices.map((d) => [d.id, d]));
  const findings = [
    ...sameTimeWrites(writes),
    ...missingReversals(writes, devices),
    ...routineCollisions(home, plan, writes),
    ...repeatedPauses(plan),
  ];
  return findings.sort(compareFindings);
}

function sameTimeWrites(writes: DeviceWrite[]): HygieneFinding[] {
  const byKey = new Map<string, DeviceWrite[]>();
  for (const w of writes) {
    const key = `${w.device}\u0000${w.attr}\u0000${w.atMs}`;
    byKey.set(key, [...(byKey.get(key) ?? []), w]);
  }
  const out: HygieneFinding[] = [];
  for (const group of byKey.values()) {
    const actionIndexes = uniqueSorted(group.map((w) => w.actionIndex));
    const first = group[0];
    if (!first || actionIndexes.length < 2) continue;
    const values = [...new Set(group.map((w) => w.value))];
    const target = `${first.device}.${first.attr}`;
    const list = actionIndexes.join(' and ');
    out.push(
      values.length > 1
        ? {
            stage: 'hygiene',
            code: 'conflicting_writes',
            actionIndexes,
            device: first.device,
            attr: first.attr,
            message: `actions ${list} set ${target} to ${values.map(show).join(' and ')} at the same time; the result depends on their order`,
          }
        : {
            stage: 'hygiene',
            code: 'repeated_write',
            actionIndexes,
            device: first.device,
            attr: first.attr,
            message: `actions ${list} both set ${target} to ${show(first.value)} at the same time`,
          },
    );
  }
  return out;
}

/** Writes that leave the home in a riskier state until something undoes them. */
export function needsReversal(device: Device, attr: string, value: Value): boolean {
  if (attr === 'lockState') return value === 'UNLOCKED';
  if (attr === 'onOff') return value === true && device.heatProducing === true;
  return false;
}

function missingReversals(writes: DeviceWrite[], devices: Map<string, Device>): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const w of writes) {
    const device = devices.get(w.device);
    if (!device || !needsReversal(device, w.attr, w.value)) continue;
    const reversed = writes.some(
      (later) =>
        later.device === w.device &&
        later.attr === w.attr &&
        later.value !== w.value &&
        (later.atMs > w.atMs || (later.atMs === w.atMs && later.actionIndex > w.actionIndex)),
    );
    if (reversed) continue;
    out.push({
      stage: 'hygiene',
      code: 'missing_reversal',
      actionIndexes: [w.actionIndex],
      device: w.device,
      attr: w.attr,
      message:
        w.attr === 'lockState'
          ? `${w.device} is unlocked and nothing in the plan locks it again`
          : `${w.device} is turned on and nothing in the plan turns it off`,
    });
  }
  return out;
}

function routineCollisions(home: Home, plan: Plan, writes: DeviceWrite[]): HygieneFinding[] {
  const utcOffset = offsetMinutes(home.home.utcOffset);
  const nowMs = toMs(plan.context.now);
  // A pause already in the home holds unless the plan replaces it (decision 34).
  const pausedUntil = new Map<string, number>();
  for (const r of home.routines) if (r.pausedUntil) pausedUntil.set(r.id, toMs(r.pausedUntil));
  for (const a of plan.actions) {
    if ('routine' in a) pausedUntil.set(a.routine, toMs(a.pauseUntil));
  }

  const out: HygieneFinding[] = [];
  for (const routine of home.routines) {
    if (!routine.enabled) continue;
    const triggerMinute = clockMinutes(routine.trigger.at);
    for (const step of routine.actions) {
      const after = step.afterMinutes ?? 0;
      const minute = (triggerMinute + after) % (24 * 60);
      const targets = 'device' in step ? [step.device] : (own(home.groups, step.group) ?? []);
      for (const w of writes) {
        if (localMinuteOfDay(w.atMs, utcOffset) !== minute) continue;
        if (!targets.includes(w.device) || !hasOwn(step.set, w.attr)) continue;
        const routineValue = own(step.set, w.attr);
        if (routineValue === undefined || routineValue === w.value) continue;
        // Routine steps run at the start of their minute; one before now has already happened.
        if (w.atMs < nowMs) continue;
        // A pause stops triggers from now on; steps of a run that started earlier still happen.
        const triggerMs = w.atMs - after * MINUTE_MS;
        const pause = pausedUntil.get(routine.id);
        if (pause !== undefined && triggerMs >= nowMs && triggerMs < pause) continue;
        out.push({
          stage: 'hygiene',
          code: 'routine_collision',
          actionIndexes: [w.actionIndex],
          device: w.device,
          attr: w.attr,
          routine: routine.id,
          message: `at ${formatClock(minute)} the ${routine.name} routine sets ${w.device}.${w.attr} to ${show(routineValue)} while the plan sets ${show(w.value)}; which one wins depends on order`,
        });
      }
    }
  }
  return out;
}

function repeatedPauses(plan: Plan): HygieneFinding[] {
  const byRoutine = new Map<string, { index: number; until: string }[]>();
  plan.actions.forEach((a, index) => {
    if (!('routine' in a)) return;
    byRoutine.set(a.routine, [...(byRoutine.get(a.routine) ?? []), { index, until: a.pauseUntil }]);
  });
  const out: HygieneFinding[] = [];
  for (const [routine, pauses] of byRoutine) {
    if (pauses.length < 2) continue;
    const actionIndexes = pauses.map((p) => p.index);
    const untils = new Set(pauses.map((p) => toMs(p.until)));
    const last = pauses[pauses.length - 1]?.until;
    out.push(
      untils.size > 1
        ? {
            stage: 'hygiene',
            code: 'conflicting_pauses',
            actionIndexes,
            routine,
            message: `actions ${actionIndexes.join(' and ')} pause ${routine} until different times; the last one, ${last}, wins`,
          }
        : {
            stage: 'hygiene',
            code: 'repeated_pause',
            actionIndexes,
            routine,
            message: `actions ${actionIndexes.join(' and ')} pause ${routine} until the same time`,
          },
    );
  }
  return out;
}

function compareFindings(a: HygieneFinding, b: HygieneFinding): number {
  return (
    (a.actionIndexes[0] ?? -1) - (b.actionIndexes[0] ?? -1) ||
    cmp(a.code, b.code) ||
    cmp(a.device ?? '', b.device ?? '') ||
    cmp(a.attr ?? '', b.attr ?? '') ||
    cmp(a.routine ?? '', b.routine ?? '')
  );
}

/** Plain code-unit order, so sorting never depends on the runtime's locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

function show(value: Value): string {
  return typeof value === 'string' ? value : String(value);
}
