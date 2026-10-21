import type { Home, Plan, Rule, RulePriority, Value } from '@shadow-home/twin';
import { computeHorizon } from './horizon.ts';
import { type HygieneFinding, hygiene } from './hygiene.ts';
import { type LintCode, type LintResult, lint } from './lint.ts';
import { AWAY_UNSTATED, awayUnstated } from './presence.ts';
import { createRuleTracker, pushesTowardViolation, type RuleOutcome, ruleAtoms } from './rules.ts';
import {
  type Change,
  RUN_NAMES,
  type RunName,
  type SimTrace,
  simulate,
  TRACE_STEP_MINUTES,
} from './simulate.ts';
import { formatIso, offsetMinutes } from './time.ts';
import { untrustedSensors } from './trust.ts';

export type Verdict = 'SAFE' | 'UNSAFE' | 'UNPROVEN';

/** A state change, as reported: when, what changed it, and from what to what. */
export interface TimelineEntry {
  at: string;
  /** "plan" or the routine's ID. */
  source: string;
  actionIndex?: number;
  /** Device ID, or "home" for a mode change. */
  device: string;
  attr: string;
  from: Value | null;
  to: Value;
}

interface RuleReason {
  rule: string;
  text: string;
  author: string;
  priority: RulePriority;
  /** The rule forbids the plan outright (for example disabling a smoke alarm). */
  refuse?: true;
  firstAt: string;
  /** The latest change at or before the rule first broke that pushed it toward breaking. */
  cause?: TimelineEntry;
}

export type Reason =
  | {
      kind: 'invalid';
      code: LintCode;
      actionIndex: number | null;
      device?: string;
      attr?: string;
      message: string;
    }
  | (RuleReason & { kind: 'violation'; run: 'nominal' })
  | (RuleReason & { kind: 'not_robust'; run: 'pessimistic' | 'optimistic' })
  | (Partial<RuleReason> & { kind: 'unknown'; message: string });

export interface RunReport {
  /** Rules broken at some step of this run. */
  violated: string[];
  /** Rules that couldn't be decided at some step (and were never broken). */
  unknown: string[];
  zoneMinC: Record<string, { tempC: number; at: string }>;
  loopGuardTrippedAt: string[];
}

/**
 * The temperatures of the three runs over the simulation, sampled for drawing rather than kept
 * every minute. Sample `i` is at `start` plus `i × stepMinutes`, except the last, which is always
 * at `end` (so the last gap can be shorter). Rounded to 0.1 °C.
 */
export interface TemperatureTrace {
  start: string;
  end: string;
  stepMinutes: number;
  /**
   * The forecast at each sample, as the nominal run reads it; the other runs shift it by their
   * offset.
   */
  outdoorC: number[];
  /** Each zone's temperature at each sample, by run: the same readings the rules checked. */
  zonesC: Record<RunName, Record<string, number[]>>;
}

export interface CheckResult {
  verdict: Verdict;
  /** Most important first: invalid, then broken rules by priority and time, then unknowns. */
  reasons: Reason[];
  /** Everything the engine couldn't establish, in plain words. */
  unknowns: string[];
  lint: LintResult;
  hygiene: HygieneFinding[];
  horizon: { start: string; end: string };
  /** The nominal run's changes, plan and routines together. Empty when lint fails. */
  timeline: TimelineEntry[];
  /** Absent when lint fails: an invalid plan is never simulated. */
  runs?: Record<RunName, RunReport>;
  /** Absent when lint fails, like `runs`. */
  temperatures?: TemperatureTrace;
}

/**
 * The verdict engine: lint, hygiene, three simulations, rules.
 *
 * UNSAFE: lint fails, or a rule breaks in the nominal run.
 * UNPROVEN: the nominal run holds but another run breaks a rule, or anything is unknown
 * (an untrusted sensor a rule depends on, a stretch of time the simulation can't cover, or who's
 * away when the plan sets away mode without saying).
 * SAFE: every run holds and every check is known.
 */
export function check(home: Home, plan: Plan): CheckResult {
  const offset = offsetMinutes(home.home.utcOffset);
  const iso = (ms: number) => formatIso(ms, offset);
  const lintResult = lint(home, plan);
  const hygieneFindings = hygiene(home, plan);
  const horizon = computeHorizon(home, plan);
  const horizonOut = { start: iso(horizon.startMs), end: iso(horizon.endMs) };

  if (!lintResult.ok) {
    return {
      verdict: 'UNSAFE',
      reasons: lintResult.findings.map((f) => ({
        kind: 'invalid',
        code: f.code,
        actionIndex: f.actionIndex,
        ...(f.device === undefined ? {} : { device: f.device }),
        ...(f.attr === undefined ? {} : { attr: f.attr }),
        message: f.message,
      })),
      unknowns: [],
      lint: lintResult,
      hygiene: hygieneFindings,
      horizon: horizonOut,
      timeline: [],
    };
  }

  const untrusted = untrustedSensors(home, plan);
  const results = {} as Record<
    RunName,
    { outcomes: RuleOutcome[]; changes: Change[]; trace: SimTrace }
  >;
  const runs = {} as Record<RunName, RunReport>;
  for (const name of RUN_NAMES) {
    const tracker = createRuleTracker(home, untrusted);
    const zoneMin: Record<string, { tempC: number; ms: number }> = {};
    const sim = simulate(home, plan, name, horizon, (frame) => {
      tracker.observe(frame);
      for (const zone in frame.zoneTempC) {
        const tempC = frame.zoneTempC[zone] as number;
        const min = zoneMin[zone];
        if (!min) zoneMin[zone] = { tempC, ms: frame.ms };
        else if (tempC < min.tempC) {
          min.tempC = tempC;
          min.ms = frame.ms;
        }
      }
    });
    const outcomes = tracker.outcomes();
    results[name] = { outcomes, changes: sim.changes, trace: sim.trace };
    runs[name] = {
      violated: outcomes.filter((o) => o.status === 'violated').map((o) => o.rule),
      unknown: outcomes.filter((o) => o.status === 'unknown').map((o) => o.rule),
      zoneMinC: Object.fromEntries(
        Object.entries(zoneMin).map(([z, m]) => [z, { tempC: round2(m.tempC), at: iso(m.ms) }]),
      ),
      loopGuardTrippedAt: sim.loopGuardTrippedAt.map(iso),
    };
  }

  const entry = (c: Change): TimelineEntry => ({
    at: iso(c.atMs),
    source: c.source,
    ...(c.actionIndex === undefined ? {} : { actionIndex: c.actionIndex }),
    device: c.device,
    attr: c.attr,
    from: c.from ?? null,
    to: c.to,
  });
  const causeOf = (rule: Rule, run: RunName, atMs: number): TimelineEntry | undefined => {
    // The latest change that pushed this rule toward breaking. None when what tipped it was
    // something else, such as everyone leaving.
    const atoms = ruleAtoms(home, rule);
    const changes = results[run].changes;
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i];
      if (c && c.atMs <= atMs && pushesTowardViolation(atoms, c.device, c.attr, c.to)) {
        return entry(c);
      }
    }
    return undefined;
  };
  const ruleReason = (rule: Rule, run: RunName, atMs: number): RuleReason => {
    const cause = causeOf(rule, run, atMs);
    return {
      rule: rule.id,
      text: rule.text,
      author: rule.author,
      priority: rule.priority,
      ...(rule.refuse ? { refuse: true as const } : {}),
      firstAt: iso(atMs),
      ...(cause ? { cause } : {}),
    };
  };

  const reasons: Reason[] = [];
  const ruleUnknowns: string[] = [];
  home.rules.forEach((rule, i) => {
    const per = (run: RunName) => results[run].outcomes[i] as RuleOutcome;
    const nominal = per('nominal');
    if (nominal.firstViolationMs !== undefined) {
      reasons.push({
        kind: 'violation',
        run: 'nominal',
        ...ruleReason(rule, 'nominal', nominal.firstViolationMs),
      });
      return;
    }
    for (const run of ['pessimistic', 'optimistic'] as const) {
      const ms = per(run).firstViolationMs;
      if (ms !== undefined) {
        reasons.push({ kind: 'not_robust', run, ...ruleReason(rule, run, ms) });
        return;
      }
    }
    const unknownRun = RUN_NAMES.find((run) => per(run).status === 'unknown');
    if (unknownRun) {
      const o = per(unknownRun);
      const because =
        o.unknownBecause.length > 0 ? o.unknownBecause : ['a reading it needs is unknown'];
      ruleUnknowns.push(...because);
      const { cause: _cause, ...base } = ruleReason(
        rule,
        unknownRun,
        o.firstUnknownMs ?? horizon.startMs,
      );
      reasons.push({ kind: 'unknown', ...base, message: because.join('; ') });
    }
  });

  const priorityRank = (r: Reason) =>
    'priority' in r && r.priority
      ? home.rulePriorityOrder.indexOf(r.priority)
      : home.rulePriorityOrder.length;
  const kindRank = { invalid: 0, violation: 1, not_robust: 2, unknown: 3 } as const;
  reasons.sort(
    (a, b) =>
      kindRank[a.kind] - kindRank[b.kind] ||
      priorityRank(a) - priorityRank(b) ||
      cmp(('firstAt' in a && a.firstAt) || '', ('firstAt' in b && b.firstAt) || ''),
  );

  const otherUnknowns = [
    ...(awayUnstated(plan) ? [AWAY_UNSTATED] : []),
    ...horizon.unknowns,
    ...RUN_NAMES.flatMap((run) =>
      runs[run].loopGuardTrippedAt.map(
        (at) =>
          `routines tried more than ${home.simulation.loopGuardActionsPerStep} actions at ${at} (${run} run)`,
      ),
    ),
  ];
  for (const message of otherUnknowns) reasons.push({ kind: 'unknown', message });
  const unknowns = [...new Set([...ruleUnknowns, ...otherUnknowns])];

  const verdict: Verdict = reasons.some((r) => r.kind === 'violation')
    ? 'UNSAFE'
    : reasons.length > 0
      ? 'UNPROVEN'
      : 'SAFE';

  return {
    verdict,
    reasons,
    unknowns,
    lint: lintResult,
    hygiene: hygieneFindings,
    horizon: horizonOut,
    timeline: results.nominal.changes.map(entry),
    runs,
    temperatures: {
      ...horizonOut,
      stepMinutes: TRACE_STEP_MINUTES,
      outdoorC: results.nominal.trace.outdoorC.map(round1),
      zonesC: Object.fromEntries(
        RUN_NAMES.map((run) => [
          run,
          Object.fromEntries(
            Object.entries(results[run].trace.zoneTempC).map(([z, temps]) => [
              z,
              temps.map(round1),
            ]),
          ),
        ]),
      ) as TemperatureTrace['zonesC'],
    },
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
