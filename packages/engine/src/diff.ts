import { type Home, own, type Plan, type Value } from '@shadow-home/twin';
import { type Reversibility, reversibility } from './reversibility.ts';
import { floorToMinute, formatIso, offsetMinutes, toMs } from './time.ts';
import { expandWrites } from './writes.ts';

/** One thing the plan changes, as a person would read it. */
export interface DiffRow {
  /** Device ID, "home" for the mode, or the routine's ID for a pause. */
  target: string;
  /** Device or routine name, or "Home mode". */
  name: string;
  kind: 'device' | 'mode' | 'routine';
  /** The attribute written; "pausedUntil" for a routine pause. */
  attr: string;
  /** Value before the plan; null when it had none (a routine that wasn't paused). */
  from: Value | null;
  to: Value;
  at: string;
  actionIndex: number;
  /** Set when a group action reached this device. */
  group?: string;
  reversibility: Reversibility;
}

/**
 * What the plan changes, one row per device attribute (the last write wins), mode and routine
 * pause, in plan order. Writes that leave a value as it was are left out.
 */
export function diffPlan(home: Home, plan: Plan): DiffRow[] {
  const offset = offsetMinutes(home.home.utcOffset);
  const iso = (ms: number) => formatIso(ms, offset);
  const tags = reversibility(home, plan);
  const devices = new Map(home.devices.map((d) => [d.id, d]));
  const overrides = plan.context.stateOverrides ?? {};
  const before = (device: string, attr: string): Value | undefined =>
    own(own(overrides, device)?.state ?? {}, attr) ?? own(devices.get(device)?.state ?? {}, attr);

  const rows = new Map<string, DiffRow>();
  const put = (key: string, row: DiffRow) => {
    rows.delete(key);
    rows.set(key, row);
  };
  const nowMs = floorToMinute(toMs(plan.context.now));
  const rev = (i: number): Reversibility => tags[i]?.reversibility ?? 'compensable';

  const writes = expandWrites(home, plan);
  let w = 0;
  plan.actions.forEach((action, actionIndex) => {
    if ('set' in action) {
      for (; w < writes.length && writes[w]?.actionIndex === actionIndex; w++) {
        const write = writes[w];
        if (!write) continue;
        put(`d\u0000${write.device}\u0000${write.attr}`, {
          target: write.device,
          name: devices.get(write.device)?.name ?? write.device,
          kind: 'device',
          attr: write.attr,
          from: before(write.device, write.attr) ?? null,
          to: write.value,
          at: iso(write.atMs),
          actionIndex,
          ...(write.group ? { group: write.group } : {}),
          reversibility: rev(actionIndex),
        });
      }
    } else if ('mode' in action) {
      put('mode', {
        target: 'home',
        name: 'Home mode',
        kind: 'mode',
        attr: 'mode',
        from: home.mode,
        to: action.mode,
        at: iso(action.at ? floorToMinute(toMs(action.at)) : nowMs),
        actionIndex,
        reversibility: rev(actionIndex),
      });
    } else {
      const routine = home.routines.find((r) => r.id === action.routine);
      put(`r\u0000${action.routine}`, {
        target: action.routine,
        name: routine?.name ?? action.routine,
        kind: 'routine',
        attr: 'pausedUntil',
        from: routine?.pausedUntil ?? null,
        to: action.pauseUntil,
        at: iso(nowMs),
        actionIndex,
        reversibility: rev(actionIndex),
      });
    }
  });
  return [...rows.values()].filter((r) => r.from !== r.to);
}
