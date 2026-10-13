import { type Home, own, type Plan } from '@shadow-home/twin';
import { floorToMinute, toMs } from './time.ts';

/**
 * How far an action can be taken back:
 * - holdable: it hasn't fired yet, so it can be cancelled outright
 * - compensable: it has fired; the state can be put back, but what already happened stays
 *   (the heat not used while the thermostat was down)
 * - irreversible: it has fired and can't be put back
 */
export type Reversibility = 'holdable' | 'compensable' | 'irreversible';

export interface ActionTag {
  actionIndex: number;
  reversibility: Reversibility;
  /** Once it fires, it can't be taken back. True for an irreversible action that is still held. */
  irreversibleOnceFired: boolean;
}

/**
 * Tag each action. An action fires at its `at` (or at `now`); one in a later minute than `now`
 * is held until then. A write is irreversible when any device it reaches lists the attribute
 * in `irreversible`. Routine pauses and mode changes can always be put back.
 */
export function reversibility(home: Home, plan: Plan): ActionTag[] {
  const nowMinute = floorToMinute(toMs(plan.context.now));
  const devices = new Map(home.devices.map((d) => [d.id, d]));
  return plan.actions.map((action, actionIndex) => {
    const at = 'at' in action && action.at ? floorToMinute(toMs(action.at)) : nowMinute;
    let oneWay = false;
    if ('set' in action) {
      const targets = 'group' in action ? (own(home.groups, action.group) ?? []) : [action.device];
      oneWay = targets.some((id) => {
        const marked = devices.get(id)?.irreversible ?? [];
        return Object.keys(action.set).some((attr) => marked.includes(attr));
      });
    }
    const fired: Reversibility = oneWay ? 'irreversible' : 'compensable';
    return {
      actionIndex,
      reversibility: at > nowMinute ? 'holdable' : fired,
      irreversibleOnceFired: oneWay,
    };
  });
}
