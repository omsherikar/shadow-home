import type { Answer, Failure } from '../adapters/checker.ts';
import { type Metrics, pct, type Scored } from './metrics.ts';

export interface CheckerRun {
  name: string;
  metrics: Metrics;
  rows: Scored[];
}

const ms = (n: number) => `${Math.round(n)} ms`;

/** The report as Markdown: the metrics side by side, then every plan a checker got wrong. */
export function markdownReport(runs: CheckerRun[], skipped: string[]): string {
  const [first] = runs;
  const lines = [
    '# ShadowBench report',
    '',
    `${first?.metrics.plans ?? 0} plans with approved labels${skipped.length ? `; ${skipped.length} skipped without one (${skipped.join(', ')})` : ''}.`,
    `Labels were written by reading each plan, never by running a checker. ${provenance(first?.rows ?? [])}`,
    '',
    `| Metric | ${runs.map((r) => r.name).join(' | ')} |`,
    `| --- | ${runs.map(() => '---').join(' | ')} |`,
  ];
  const row = (name: string, cell: (m: Metrics) => string) =>
    lines.push(`| ${name} | ${runs.map((r) => cell(r.metrics)).join(' | ')} |`);
  row('Verdict matches the label', (m) => pct(m.accuracy));
  row('Catch rate (unsafe and invalid plans called UNSAFE)', (m) => pct(m.catchRate));
  row('False blocks (safe plans not let through)', (m) => pct(m.falseBlock));
  row('… of which called UNSAFE', (m) => pct(m.falseUnsafe));
  row('UNPROVEN precision', (m) => pct(m.unprovenPrecision));
  row('UNPROVEN recall', (m) => pct(m.unprovenRecall));
  row('Repair success (caught UNSAFE plans whose fix is SAFE)', (m) => pct(m.repairSuccess));
  row('… on the unsafe set (invalid plans get no fix)', (m) => pct(m.repairSuccessUnsafeSet));
  row('Named every rule the label names (right verdicts)', (m) => pct(m.rulesNamed));
  row(
    'Latency p50 / p99 / max',
    (m) => `${ms(m.latencyMs.p50)} / ${ms(m.latencyMs.p99)} / ${ms(m.latencyMs.max)}`,
  );
  row('No answer', (m) => String(m.errors));

  lines.push('', '## By set', '', `| Set | ${runs.map((r) => r.name).join(' | ')} |`);
  lines.push(`| --- | ${runs.map(() => '---').join(' | ')} |`);
  for (const set of ['unsafe', 'safe', 'invalid', 'unprovable'] as const) {
    lines.push(`| ${set} | ${runs.map((r) => pct(r.metrics.bySet[set])).join(' | ')} |`);
  }

  for (const run of runs.filter((r) => r.metrics.repairSuccessUnsafeSet)) {
    const unfixed = run.rows.filter(
      (s) =>
        s.item.set === 'unsafe' &&
        !('error' in s.answer) &&
        s.answer.verdict === 'UNSAFE' &&
        s.answer.repairedVerdict !== 'SAFE',
    );
    lines.push('', `## ${run.name}: unsafe plans without a SAFE fix (${unfixed.length})`);
    if (unfixed.length === 0) continue;
    lines.push('', '| Plan | Rules broken | Best fix | Request |', '| --- | --- | --- | --- |');
    for (const s of unfixed) {
      if ('error' in s.answer) continue;
      lines.push(
        `| ${s.item.id} | ${s.answer.rules.join(', ')} | ${s.answer.repairedVerdict ?? 'none'} | ${s.item.request.replaceAll('|', '/')} |`,
      );
    }
  }

  for (const run of runs) {
    const wrong = run.rows.filter((s) => verdictOf(s.answer) !== s.item.label.expected);
    lines.push('', `## ${run.name}: ${wrong.length} disagreement${wrong.length === 1 ? '' : 's'}`);
    if (wrong.length === 0) continue;
    lines.push('', '| Plan | Set | Label | Answer | Rules (label → answer) | Request |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const s of wrong) {
      const rules = `${s.item.label.expectedRules.join(', ') || '-'} → ${'error' in s.answer ? s.answer.error : s.answer.rules.join(', ') || '-'}`;
      lines.push(
        `| ${s.item.id} | ${s.item.set} | ${s.item.label.expected} | ${verdictOf(s.answer)} | ${rules} | ${s.item.request.replaceAll('|', '/')} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Who drafted and who approved the labels, so a reader can weigh the agreement. */
function provenance(rows: Scored[]): string {
  const count = (pick: (s: Scored) => string | null) => {
    const n = new Map<string, number>();
    for (const s of rows) n.set(pick(s) ?? 'nobody', (n.get(pick(s) ?? 'nobody') ?? 0) + 1);
    return [...n].map(([who, k]) => `${who} ${k}`).join(', ');
  };
  return `Drafted by: ${count((s) => s.item.label.draftedBy)}. Approved by: ${count((s) => s.item.label.approvedBy)}.`;
}

function verdictOf(a: Answer | Failure): string {
  return 'error' in a ? 'no answer' : a.verdict;
}
