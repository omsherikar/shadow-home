import type { Plan } from '@shadow-home/twin';

/** What the check can't establish when a plan sets the house to away without saying who's away. */
export const AWAY_UNSTATED = "who's away, and until when, isn't given";

/**
 * Whether the plan sets the home to away mode with no presence schedule (missing or empty).
 * Without one the twin keeps the household as it is now for the whole run, so the rules for an
 * empty house would never apply. The check reports it as unknown instead of assuming who stays.
 */
export function awayUnstated(plan: Plan): boolean {
  return (
    (plan.context.presenceSchedule ?? []).length === 0 &&
    plan.actions.some((a) => 'mode' in a && a.mode === 'away')
  );
}
