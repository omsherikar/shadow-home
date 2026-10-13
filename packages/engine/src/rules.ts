import type { Cond, Home, Rule, StateCond, Value } from '@shadow-home/twin';
import { evalCond, type Frame } from './conditions.ts';
import { and, not, type Truth } from './logic.ts';

export type RuleStatus = 'ok' | 'violated' | 'unknown';

export interface RuleOutcome {
  rule: string;
  /** violated if any step definitely breaks the rule; unknown if none does but some step can't be decided. */
  status: RuleStatus;
  firstViolationMs?: number;
  firstUnknownMs?: number;
  /** Why the rule couldn't be decided: the untrusted sensors it depends on. */
  unknownBecause: string[];
}

export interface RuleTracker {
  /** Check every rule against one simulation step. Call once per step, in time order. */
  observe(frame: Frame): void;
  /** One outcome per rule, in the home's rule order. */
  outcomes(): RuleOutcome[];
}

interface Check {
  rule: Rule;
  /**
   * Is the rule broken at this step, taking commanded values on untrusted devices at face value?
   * Null when the rule reads no untrusted device, so it can't differ from `strict`.
   */
  ifCommandsWork: ((frame: Frame) => Truth) | null;
  /** Is the rule broken at this step, with every untrusted reading unknown? */
  strict(frame: Frame): Truth;
  sensors: string[];
  firstViolationMs?: number;
  firstUnknownMs?: number;
}

/**
 * Track the home's rules over a simulated timeline.
 *
 * A rule is broken at a step if it is broken assuming every command took effect (the plan asked
 * for a forbidden state), or if it is broken outright. Otherwise an unknown reading leaves it
 * unknown: a safe command to an untrusted device may not have taken effect.
 */
export function createRuleTracker(home: Home, untrusted: ReadonlyMap<string, string>): RuleTracker {
  const checks: Check[] = home.rules.map((rule) => {
    const sensors = ruleDevices(home, rule).filter((d) => untrusted.has(d));
    const strict = compile(home, rule, untrusted, false);
    // With no untrusted device in the rule, trusting commands changes nothing: one check will do.
    return {
      rule,
      ifCommandsWork: sensors.length > 0 ? compile(home, rule, untrusted, true) : null,
      strict,
      sensors,
    };
  });
  return {
    observe(frame) {
      for (const c of checks) {
        // Evaluate both every step: within_after keeps state between steps.
        const assumed = c.ifCommandsWork ? c.ifCommandsWork(frame) : false;
        const strict = c.strict(frame);
        const v = assumed === true ? true : strict;
        if (v === true && c.firstViolationMs === undefined) c.firstViolationMs = frame.ms;
        if (v === 'unknown' && c.firstUnknownMs === undefined) c.firstUnknownMs = frame.ms;
      }
    },
    outcomes() {
      return checks.map((c) => {
        const status: RuleStatus =
          c.firstViolationMs !== undefined
            ? 'violated'
            : c.firstUnknownMs !== undefined
              ? 'unknown'
              : 'ok';
        return {
          rule: c.rule.id,
          status,
          ...(c.firstViolationMs === undefined ? {} : { firstViolationMs: c.firstViolationMs }),
          ...(c.firstUnknownMs === undefined ? {} : { firstUnknownMs: c.firstUnknownMs }),
          unknownBecause: status === 'unknown' ? c.sensors.map((d) => untrusted.get(d) ?? d) : [],
        };
      });
    },
  };
}

function compile(
  home: Home,
  rule: Rule,
  untrusted: ReadonlyMap<string, string>,
  trustCommanded: boolean,
): (frame: Frame) => Truth {
  const holds = (c: Cond, f: Frame) => evalCond(c, f, untrusted, trustCommanded);
  switch (rule.template) {
    case 'always': {
      const { state } = rule.params;
      return (f) => not(holds(state, f));
    }
    case 'never_when': {
      const { x, when } = rule.params;
      return (f) => and2(holds(x, f), () => holds(when, f));
    }
    case 'never_together': {
      const { a, b } = rule.params;
      return (f) => and2(holds(a, f), () => holds(b, f));
    }
    case 'keep_between': {
      const { quantity, min, max, when } = rule.params;
      const thermostat = home.zones.find((z) => z.id === quantity.zone)?.heater.thermostat;
      return (f) => {
        const t = f.zoneTempC[quantity.zone];
        const out: Truth =
          t === undefined || (thermostat !== undefined && untrusted.has(thermostat))
            ? 'unknown'
            : (min !== null && t < min) || (max !== null && t > max);
        return and(when ? holds(when, f) : true, out);
      };
    }
    case 'within_after': {
      // Once `after` has held for `minutes` steps in a row, every `ensure` must hold.
      const { minutes, after, ensure } = rule.params;
      let definite = 0; // consecutive steps where `after` is true
      let possible = 0; // consecutive steps where `after` is true or unknown
      return (f) => {
        const a = holds(after, f);
        definite = a === true ? definite + 1 : 0;
        possible = a === false ? 0 : possible + 1;
        const sustained: Truth = definite > minutes ? true : possible > minutes ? 'unknown' : false;
        return and2(sustained, () => {
          let all: Truth = true;
          for (const e of ensure) {
            all = and(all, holds(e, f));
            if (all === false) break;
          }
          return not(all);
        });
      };
    }
  }
}

/** Kleene AND that skips the second operand when the first is false. */
function and2(a: Truth, b: () => Truth): Truth {
  return a === false ? false : and(a, b());
}

/** Devices whose readings a rule depends on (for keep_between, the zone's thermostat). */
export function ruleDevices(home: Home, rule: Rule): string[] {
  const out = new Set<string>();
  const walk = (c: Cond): void => {
    if ('any' in c) c.any.forEach(walk);
    else if ('all' in c) c.all.forEach(walk);
    else if ('not' in c) walk(c.not);
    else if ('device' in c) out.add(c.device);
  };
  switch (rule.template) {
    case 'always':
      walk(rule.params.state);
      break;
    case 'never_when':
      walk(rule.params.x);
      walk(rule.params.when);
      break;
    case 'never_together':
      walk(rule.params.a);
      walk(rule.params.b);
      break;
    case 'keep_between': {
      const zone = home.zones.find((z) => z.id === rule.params.quantity.zone);
      if (zone) out.add(zone.heater.thermostat);
      if (rule.params.when) walk(rule.params.when);
      break;
    }
    case 'within_after':
      walk(rule.params.after);
      rule.params.ensure.forEach(walk);
      break;
  }
  return [...out];
}

/** A state condition inside a rule, and whether its being true pushes toward a violation. */
export interface RuleAtom {
  device: string;
  /** Null for keep_between's thermostat: any change to it counts. */
  cond: StateCond | null;
  towardViolation: boolean;
}

/**
 * The state conditions a rule's violation depends on, with their direction: in "never X when
 * Y" both X and Y being true push toward a violation; in "always S", S being false does.
 */
export function ruleAtoms(home: Home, rule: Rule): RuleAtom[] {
  const out: RuleAtom[] = [];
  const walk = (c: Cond, toward: boolean): void => {
    if ('any' in c) for (const x of c.any) walk(x, toward);
    else if ('all' in c) for (const x of c.all) walk(x, toward);
    else if ('not' in c) walk(c.not, !toward);
    else if ('device' in c) out.push({ device: c.device, cond: c, towardViolation: toward });
  };
  switch (rule.template) {
    case 'always':
      walk(rule.params.state, false);
      break;
    case 'never_when':
      walk(rule.params.x, true);
      walk(rule.params.when, true);
      break;
    case 'never_together':
      walk(rule.params.a, true);
      walk(rule.params.b, true);
      break;
    case 'keep_between': {
      const zone = home.zones.find((z) => z.id === rule.params.quantity.zone);
      if (zone) out.push({ device: zone.heater.thermostat, cond: null, towardViolation: true });
      if (rule.params.when) walk(rule.params.when, true);
      break;
    }
    case 'within_after':
      walk(rule.params.after, true);
      for (const e of rule.params.ensure) walk(e, false);
      break;
  }
  return out;
}

/** Does writing `value` to device.attr push this rule toward a violation? */
export function pushesTowardViolation(
  atoms: readonly RuleAtom[],
  device: string,
  attr: string,
  value: Value,
): boolean {
  return atoms.some((a) => {
    if (a.device !== device) return false;
    if (a.cond === null) return true;
    if (a.cond.attr !== attr) return false;
    const holds = 'eq' in a.cond ? value === a.cond.eq : value !== a.cond.neq;
    return holds === a.towardViolation;
  });
}
