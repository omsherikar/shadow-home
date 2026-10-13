import {
  attrDomain,
  checkValue,
  type Device,
  HOME_MODES,
  type Home,
  hasOwn,
  own,
  type Plan,
  type PresenceSpec,
  type Value,
  type ValueProblemCode,
} from '@shadow-home/twin';
import { toMs } from './time.ts';

export type LintCode =
  | 'unknown_device'
  | 'unknown_group'
  | 'unknown_routine'
  | 'unknown_mode'
  | 'unknown_member'
  | 'unsupported_attribute'
  | ValueProblemCode
  | 'time_in_past'
  | 'pause_in_past'
  | 'plan_end_in_past'
  | 'presence_window_reversed'
  | 'presence_windows_overlap';

export interface LintFinding {
  stage: 'lint';
  kind: 'invalid';
  code: LintCode;
  /** Index into plan.actions, or null for a problem in the plan's context. */
  actionIndex: number | null;
  device?: string;
  attr?: string;
  message: string;
}

export interface LintResult {
  ok: boolean;
  findings: LintFinding[];
}

/**
 * Stage 1. Can the home do what the plan asks at all? Every device, group, routine and mode
 * exists, every attribute is writable, every value is in range, and no time is in the past.
 * Any finding makes the plan UNSAFE with reason kind "invalid".
 */
export function lint(home: Home, plan: Plan): LintResult {
  const findings: LintFinding[] = [];
  const devices = new Map(home.devices.map((d) => [d.id, d]));
  const routines = new Set(home.routines.map((r) => r.id));
  const members = new Set(home.household.members.map((m) => m.id));
  const nowMs = toMs(plan.context.now);
  const add = (f: Omit<LintFinding, 'stage' | 'kind'>) =>
    findings.push({ stage: 'lint', kind: 'invalid', ...f });

  const { planEnd, presenceSchedule = [] } = plan.context;
  if (planEnd && toMs(planEnd) <= nowMs) {
    add({
      code: 'plan_end_in_past',
      actionIndex: null,
      message: `the plan ends at ${planEnd}, before now`,
    });
  }
  for (const window of presenceSchedule) {
    if (toMs(window.to) <= toMs(window.from)) {
      add({
        code: 'presence_window_reversed',
        actionIndex: null,
        message: `presence window ${window.from} to ${window.to} ends before it starts`,
      });
    }
    if (typeof window.presence === 'object') {
      for (const m of window.presence.home) {
        if (!members.has(m)) {
          add({
            code: 'unknown_member',
            actionIndex: null,
            message: `${m} isn't in the household`,
          });
        }
      }
    }
  }

  presenceSchedule.forEach((a, i) => {
    for (const b of presenceSchedule.slice(i + 1)) {
      const overlap = toMs(a.from) < toMs(b.to) && toMs(b.from) < toMs(a.to);
      if (overlap && presenceKey(a.presence) !== presenceKey(b.presence)) {
        add({
          code: 'presence_windows_overlap',
          actionIndex: null,
          message: `presence windows ${a.from} to ${a.to} and ${b.from} to ${b.to} overlap and disagree`,
        });
      }
    }
  });

  plan.actions.forEach((action, actionIndex) => {
    if ('at' in action && action.at && toMs(action.at) < nowMs) {
      add({ code: 'time_in_past', actionIndex, message: `scheduled for ${action.at}, before now` });
    }

    if ('device' in action) {
      const device = devices.get(action.device);
      if (!device) {
        add({
          code: 'unknown_device',
          actionIndex,
          device: action.device,
          message: `the home has no device called ${action.device}`,
        });
        return;
      }
      for (const f of checkSet(device, action.set)) add({ actionIndex, ...f });
    } else if ('group' in action) {
      const memberIds = own(home.groups, action.group);
      if (!memberIds) {
        add({
          code: 'unknown_group',
          actionIndex,
          message: `the home has no group called ${action.group}`,
        });
        return;
      }
      for (const id of memberIds) {
        const device = devices.get(id);
        if (!device) continue; // validateHome guarantees members exist
        for (const f of checkSet(device, action.set)) {
          add({ actionIndex, ...f, message: `${action.group} includes ${id}: ${f.message}` });
        }
      }
    } else if ('routine' in action) {
      if (!routines.has(action.routine)) {
        add({
          code: 'unknown_routine',
          actionIndex,
          message: `the home has no routine called ${action.routine}`,
        });
      } else if (toMs(action.pauseUntil) <= nowMs) {
        add({
          code: 'pause_in_past',
          actionIndex,
          message: `pausing ${action.routine} until ${action.pauseUntil} has no effect, that's not after now`,
        });
      }
    } else if (!(HOME_MODES as readonly string[]).includes(action.mode)) {
      add({
        code: 'unknown_mode',
        actionIndex,
        message: `the home has no mode called ${action.mode}; it has ${HOME_MODES.join(', ')}`,
      });
    }
  });

  return { ok: findings.length === 0, findings };
}

/** A comparable form of a presence spec: "nobody", "everyone", or the sorted names home. */
function presenceKey(p: PresenceSpec): string {
  return typeof p === 'string' ? p : [...p.home].sort().join(',');
}

type SetFinding = Omit<LintFinding, 'stage' | 'kind' | 'actionIndex'>;

function checkSet(device: Device, set: Record<string, Value>): SetFinding[] {
  const out: SetFinding[] = [];
  for (const [attr, value] of Object.entries(set)) {
    const cap = own(device.capabilities, attr);
    if (!cap) {
      const readOnly = hasOwn(device.state, attr);
      out.push({
        code: 'unsupported_attribute',
        device: device.id,
        attr,
        message: readOnly
          ? `${device.id}.${attr} is read-only`
          : `${device.id} has no ${attr} to set`,
      });
      continue;
    }
    const bad = checkValue(cap, value);
    if (bad)
      out.push({
        code: bad.code,
        device: device.id,
        attr,
        message: `${device.id}.${attr}: ${bad.message}`,
      });
  }
  return out;
}

/**
 * State overrides are bench scaffolding (a low battery, an open window), not something an
 * assistant proposes, so a bad one is a broken test case rather than an invalid plan.
 */
export function checkOverrides(home: Home, plan: Plan): string[] {
  const problems: string[] = [];
  const devices = new Map(home.devices.map((d) => [d.id, d]));
  for (const [id, override] of Object.entries(plan.context.stateOverrides ?? {})) {
    const device = devices.get(id);
    if (!device) {
      problems.push(`override for unknown device ${id}`);
      continue;
    }
    for (const [attr, value] of Object.entries(override.state ?? {})) {
      if (!hasOwn(device.state, attr) && !hasOwn(device.capabilities, attr)) {
        problems.push(`override sets ${id}.${attr}, which it does not have`);
        continue;
      }
      const domain = attrDomain(device, attr);
      const bad = domain ? checkValue(domain, value) : null;
      if (bad) problems.push(`override sets ${id}.${attr}: ${bad.message}`);
    }
  }
  return problems;
}
