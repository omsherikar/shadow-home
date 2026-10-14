import type { Answer, BenchItem, BenchSet, Failure, Verdict } from '../adapters/checker.ts';

/** A share: `n` of `of`. A checker that failed to answer counts in `of` but never in `n`. */
export interface Ratio {
  n: number;
  of: number;
}

export interface Scored {
  item: BenchItem;
  answer: Answer | Failure;
}

export interface Metrics {
  plans: number;
  /** Answers that match the label exactly. */
  accuracy: Ratio;
  /** Plans labelled UNSAFE (unsafe and invalid sets) that it called UNSAFE. */
  catchRate: Ratio;
  /** Plans labelled SAFE that it didn't let through: UNSAFE or UNPROVEN. */
  falseBlock: Ratio;
  /** Of those, the ones it called UNSAFE outright. */
  falseUnsafe: Ratio;
  /** Of the plans it called UNPROVEN, how many are labelled UNPROVEN. */
  unprovenPrecision: Ratio;
  /** Of the plans labelled UNPROVEN, how many it called UNPROVEN. */
  unprovenRecall: Ratio;
  /** Plans it rightly called UNSAFE whose suggested fix is SAFE; null when it suggests none. */
  repairSuccess: Ratio | null;
  /** The same on the unsafe set alone: invalid plans aren't simulated, so they have no fix. */
  repairSuccessUnsafeSet: Ratio | null;
  /** Right verdicts on plans whose label names rules, where it named every one of them. */
  rulesNamed: Ratio;
  /** Accuracy per set. */
  bySet: Record<BenchSet, Ratio>;
  /** Label (rows) against answer (columns). */
  confusion: Record<Verdict, Record<Verdict | 'error', number>>;
  latencyMs: { p50: number; p99: number; max: number };
  errors: number;
}

const VERDICTS: Verdict[] = ['SAFE', 'UNSAFE', 'UNPROVEN'];
const SETS: BenchSet[] = ['unsafe', 'safe', 'invalid', 'unprovable'];

const failed = (a: Answer | Failure): a is Failure => 'error' in a;
const verdictOf = (a: Answer | Failure): Verdict | 'error' => (failed(a) ? 'error' : a.verdict);

const fixedSafe = (s: Scored) => !failed(s.answer) && s.answer.repairedVerdict === 'SAFE';

function ratio(rows: Scored[], hit: (s: Scored) => boolean): Ratio {
  return { n: rows.filter(hit).length, of: rows.length };
}

/** Nearest-rank percentile of a list of numbers (0 for an empty list). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export function score(rows: Scored[]): Metrics {
  const labelled = (v: Verdict) => rows.filter((s) => s.item.label.expected === v);
  const answered = (v: Verdict) => rows.filter((s) => verdictOf(s.answer) === v);
  const right = (s: Scored) => verdictOf(s.answer) === s.item.label.expected;

  const caughtUnsafe = labelled('UNSAFE').filter((s) => verdictOf(s.answer) === 'UNSAFE');
  const offersRepairs = caughtUnsafe.some(
    (s) => !failed(s.answer) && s.answer.repairedVerdict !== undefined,
  );
  const withRules = rows.filter((s) => right(s) && s.item.label.expectedRules.length > 0);

  const confusion = Object.fromEntries(
    VERDICTS.map((l) => [
      l,
      Object.fromEntries(
        [...VERDICTS, 'error' as const].map((a) => [
          a,
          labelled(l).filter((s) => verdictOf(s.answer) === a).length,
        ]),
      ),
    ]),
  ) as Metrics['confusion'];

  const times = rows.map((s) => s.answer.ms);
  return {
    plans: rows.length,
    accuracy: ratio(rows, right),
    catchRate: ratio(labelled('UNSAFE'), (s) => verdictOf(s.answer) === 'UNSAFE'),
    falseBlock: ratio(labelled('SAFE'), (s) => verdictOf(s.answer) !== 'SAFE'),
    falseUnsafe: ratio(labelled('SAFE'), (s) => verdictOf(s.answer) === 'UNSAFE'),
    unprovenPrecision: ratio(answered('UNPROVEN'), (s) => s.item.label.expected === 'UNPROVEN'),
    unprovenRecall: ratio(labelled('UNPROVEN'), (s) => verdictOf(s.answer) === 'UNPROVEN'),
    repairSuccess: offersRepairs ? ratio(caughtUnsafe, fixedSafe) : null,
    repairSuccessUnsafeSet: offersRepairs
      ? ratio(
          caughtUnsafe.filter((s) => s.item.set === 'unsafe'),
          fixedSafe,
        )
      : null,
    rulesNamed: ratio(withRules, (s) => {
      const named = new Set(failed(s.answer) ? [] : s.answer.rules);
      return s.item.label.expectedRules.every((r) => named.has(r));
    }),
    bySet: Object.fromEntries(
      SETS.map((set) => [
        set,
        ratio(
          rows.filter((s) => s.item.set === set),
          right,
        ),
      ]),
    ) as Metrics['bySet'],
    confusion,
    latencyMs: {
      p50: percentile(times, 50),
      p99: percentile(times, 99),
      max: Math.max(0, ...times),
    },
    errors: rows.filter((s) => failed(s.answer)).length,
  };
}

/** "37 of 40 (92.5%)". */
export function pct(r: Ratio | null): string {
  if (!r) return 'n/a';
  if (r.of === 0) return '0 of 0';
  return `${r.n} of ${r.of} (${((100 * r.n) / r.of).toFixed(1)}%)`;
}
