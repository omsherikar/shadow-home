import { assess } from '@shadow-home/engine';
import type { Home } from '@shadow-home/twin';
import type { Checker } from './checker.ts';

/**
 * Shadow Home's verdict engine, called directly: a preview's whole assessment (the check, the
 * repair search and the safe part), with the plan's own time, presence and sensor states.
 */
export function shadowHome(home: Home): Checker {
  return {
    name: 'Shadow Home',
    async check({ plan }) {
      const start = performance.now();
      const a = assess(home, plan);
      const ms = performance.now() - start;
      const rules = a.check.reasons.flatMap((r) => ('rule' in r && r.rule ? [r.rule] : []));
      return {
        verdict: a.check.verdict,
        rules: [...new Set(rules)],
        repairedVerdict: a.repaired?.check.verdict ?? null,
        reason: a.speech.headline,
        ms,
      };
    },
  };
}
