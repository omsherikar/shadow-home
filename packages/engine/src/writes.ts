import { type Home, own, type Plan, type Value } from '@shadow-home/twin';
import { floorToMinute, toMs } from './time.ts';

/** One attribute write to one device, after group expansion. */
export interface DeviceWrite {
  actionIndex: number;
  device: string;
  attr: string;
  value: Value;
  atMs: number;
  /** Set when the write came from a group action. */
  group?: string;
}

/**
 * Every device write a plan makes, in plan order, with groups expanded and times resolved
 * (an action without `at` runs at context.now). Times are floored to the minute, the
 * simulation's step. Unknown devices and groups are skipped; lint reports them.
 */
export function expandWrites(home: Home, plan: Plan): DeviceWrite[] {
  const known = new Set(home.devices.map((d) => d.id));
  const nowMs = toMs(plan.context.now);
  const writes: DeviceWrite[] = [];

  plan.actions.forEach((action, actionIndex) => {
    if (!('set' in action)) return;
    const atMs = floorToMinute(action.at ? toMs(action.at) : nowMs);
    const isGroup = 'group' in action;
    const targets = isGroup ? (own(home.groups, action.group) ?? []) : [action.device];
    for (const device of targets) {
      if (!known.has(device)) continue;
      for (const [attr, value] of Object.entries(action.set)) {
        writes.push({
          actionIndex,
          device,
          attr,
          value,
          atMs,
          ...(isGroup ? { group: action.group } : {}),
        });
      }
    }
  });
  return writes;
}
