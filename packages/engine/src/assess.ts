import type { Home, Plan } from '@shadow-home/twin';
import { type DiffRow, diffPlan } from './diff.ts';
import { type RepairResult, repair, type SafePart, safePart } from './repair.ts';
import { type ActionTag, reversibility } from './reversibility.ts';
import { offeredAlternative, type Speech, speech } from './speech.ts';
import { confirmationTier, type TierResult } from './tier.ts';
import { type CheckResult, check } from './verdict.ts';

/** A checked alternative to the plan: its own actions, verdict and tier. */
export interface Alternative<T> {
  plan: Plan;
  check: CheckResult;
  tier: TierResult;
  diff: DiffRow[];
  /** Its own speech, with its own question: committing it on its own asks that. */
  speech: Speech;
  detail: T;
}

/** Everything a preview needs: the verdict, what changes, how to confirm, and what to offer instead. */
export interface Assessment {
  check: CheckResult;
  diff: DiffRow[];
  reversibility: ActionTag[];
  tier: TierResult;
  speech: Speech;
  /** A SAFE (or at least better) version of the plan, when the search found one. */
  repaired: Alternative<Pick<RepairResult, 'repairs'>> | null;
  /** The plan's own actions that are SAFE on their own, when there are some. */
  safePart: Alternative<Pick<SafePart, 'dropped'>> | null;
  /** The alternative the speech's question offers; a yes to it is a yes to that alternative. */
  offered: 'repair' | 'safe_part' | null;
}

export interface AssessOptions {
  /** Household member who asked, for "who else it affects". */
  requestedBy?: string;
}

export function assess(home: Home, plan: Plan, options: AssessOptions = {}): Assessment {
  const result = check(home, plan);
  const tags = reversibility(home, plan);
  const tier = confirmationTier(home, plan, result, tags, options.requestedBy);
  const diff = diffPlan(home, plan);
  const fixed = repair(home, plan, result);
  const part = safePart(home, plan, result);
  const alternative = <T>(p: Plan, c: CheckResult, detail: T): Alternative<T> => {
    const t = confirmationTier(home, p, c, reversibility(home, p), options.requestedBy);
    const d = diffPlan(home, p);
    return { plan: p, check: c, tier: t, diff: d, speech: speech(home, p, c, t, d), detail };
  };
  const repaired = fixed ? alternative(fixed.plan, fixed.result, { repairs: fixed.repairs }) : null;
  const subset = part ? alternative(part.plan, part.result, { dropped: part.dropped }) : null;
  const alternatives = {
    repair: repaired && {
      ...repaired,
      verdict: repaired.check.verdict,
      fixes: repaired.detail.repairs.length,
    },
    safePart: subset && { ...subset, verdict: subset.check.verdict, fixes: 0 },
  };
  return {
    check: result,
    diff,
    reversibility: tags,
    tier,
    speech: speech(home, plan, result, tier, diff, alternatives),
    repaired,
    safePart: subset,
    offered: offeredAlternative(tier, alternatives),
  };
}
