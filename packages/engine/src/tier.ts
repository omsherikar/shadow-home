import type { Home, Plan, Value } from '@shadow-home/twin';
import type { ActionTag } from './reversibility.ts';
import type { CheckResult } from './verdict.ts';
import { expandWrites } from './writes.ts';

/**
 * How Alexa should confirm, highest that applies:
 * - T5 the plan breaks a rule that forbids it outright: refuse (never a plan with no actions)
 * - T3 UNSAFE: block, cite the rule, offer the safe part
 * - T4 UNPROVEN: offer the proven part, ask one question
 * - T2 SAFE but irreversible, or it weakens security: one yes/no naming the consequence
 * - T1 SAFE and it reaches beyond the person asking: act, say who it affects
 * - T0 SAFE, reversible, only the person asking: act, offer undo
 */
export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

export interface TierResult {
  tier: Tier;
  /** One plain sentence on why this tier. */
  why: string;
  /** Members other than the person asking whom the plan affects (T1 and up). */
  affects: string[];
  /** Device IDs behind a T2: weakened security or an irreversible write. */
  sensitive: string[];
}

/** Writes that weaken security or life safety: unlocking a lock, switching off a smoke alarm. */
function weakensSecurity(kind: string, attr: string, value: Value): boolean {
  return (
    (kind === 'lock' && attr === 'lockState' && value === 'UNLOCKED') ||
    (kind === 'smoke_alarm' && attr === 'enabled' && value === false)
  );
}

/** The rule that forbids the plan outright, when one breaks in any run. */
export function refusingRule(result: CheckResult): string | undefined {
  for (const r of result.reasons) {
    if ((r.kind === 'violation' || r.kind === 'not_robust') && r.refuse) return r.rule;
  }
  return undefined;
}

export function confirmationTier(
  home: Home,
  plan: Plan,
  result: CheckResult,
  tags: readonly ActionTag[],
  requestedBy?: string,
): TierResult {
  const refused = result.reasons.find(
    (r) => (r.kind === 'violation' || r.kind === 'not_robust') && r.refuse,
  );
  const others = home.household.members.map((m) => m.id).filter((id) => id !== requestedBy);
  // A plan with no actions asks for nothing a rule could forbid: when the house already breaks a
  // refuse rule as someone leaves, that is a block with a fix on offer, not a refusal.
  if (refused && 'rule' in refused && plan.actions.length > 0) {
    return { tier: 'T5', why: `rule ${refused.rule} forbids it`, affects: [], sensitive: [] };
  }
  if (result.verdict === 'UNSAFE') {
    return { tier: 'T3', why: 'the plan is UNSAFE', affects: [], sensitive: [] };
  }
  if (result.verdict === 'UNPROVEN') {
    return { tier: 'T4', why: 'the plan is UNPROVEN', affects: [], sensitive: [] };
  }

  const devices = new Map(home.devices.map((d) => [d.id, d]));
  const writes = expandWrites(home, plan);
  const oneWay = new Set(tags.filter((t) => t.irreversibleOnceFired).map((t) => t.actionIndex));
  const sensitive = new Set<string>();
  for (const w of writes) {
    const kind = devices.get(w.device)?.kind ?? '';
    if (oneWay.has(w.actionIndex) || weakensSecurity(kind, w.attr, w.value))
      sensitive.add(w.device);
  }
  const affects = new Set<string>();
  for (const action of plan.actions) {
    // Shared by everyone: a group, the home mode, a thermostat (it heats a whole zone).
    const shared =
      'group' in action ||
      'mode' in action ||
      ('device' in action && devices.get(action.device)?.controlsZone !== undefined);
    if (shared) for (const m of others) affects.add(m);
    if ('routine' in action) {
      const owner = home.routines.find((r) => r.id === action.routine)?.owner;
      if (owner && owner !== requestedBy) affects.add(owner);
    }
  }
  const affected = home.household.members.map((m) => m.id).filter((m) => affects.has(m));
  if (sensitive.size > 0) {
    return {
      tier: 'T2',
      why: oneWay.size > 0 ? "it can't be undone once it runs" : 'it weakens security',
      affects: affected,
      sensitive: [...sensitive],
    };
  }
  if (affected.length > 0) {
    return { tier: 'T1', why: 'it affects other people', affects: affected, sensitive: [] };
  }
  return { tier: 'T0', why: 'safe and reversible', affects: [], sensitive: [] };
}
