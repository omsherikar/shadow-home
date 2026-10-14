// ShadowBench: every plan with an approved label, through each checker, into a report.
//   npm run bench                       Shadow Home only; no model calls
//   npm run bench -- --judge            the LLM judge too: one model call per plan, answers cached
//   npm run bench -- --judge --judge-model <id>
//   npm run bench -- --stress           Shadow Home again on a house whose physics is 20% off the twin
// Writes reports/report.md and reports/results.json.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHome } from '@shadow-home/twin/node';
import type { Answer, BenchItem, Checker, Failure } from '../adapters/checker.ts';
import { JUDGE_MODEL, judgeMessage, judgeSystemPrompt, llmJudge } from '../adapters/llm-judge.ts';
import { shadowHome } from '../adapters/shadow-home.ts';
import { BENCH, loadBench } from './load.ts';
import { pct, type Scored, score } from './metrics.ts';
import { type CheckerRun, markdownReport, type StressRun } from './report.ts';
import { mismatchedHome } from './stress.ts';

const argv = process.argv.slice(2);
const option = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const reports = join(BENCH, 'reports');
mkdirSync(reports, { recursive: true });
const { items, skipped } = loadBench();
// Every plan names its home relative to the repository root; today they all share one.
const homeFiles = [...new Set(items.map((i) => i.home))];
if (homeFiles.length !== 1) throw new Error(`One home expected, found: ${homeFiles.join(', ')}`);
const homeFile = join(BENCH, '..', homeFiles[0] as string);
const home = loadHome(homeFile);

/** Answers each plan in turn (or a few at once), recording failures instead of stopping. */
async function run(
  checker: Checker,
  options: {
    parallel?: number;
    cached?: (item: BenchItem) => Answer | undefined;
    /** One untimed pass first, so latency is measured warm, as a running server is. */
    warmUp?: boolean;
  } = {},
): Promise<Scored[]> {
  if (options.warmUp) for (const item of items) await checker.check(item).catch(() => undefined);
  const rows: Scored[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i] as BenchItem;
      const hit = options.cached?.(item);
      let answer: Answer | Failure;
      const start = performance.now();
      try {
        answer = hit ?? (await checker.check(item));
      } catch (e) {
        answer = {
          error: e instanceof Error ? e.message : String(e),
          ms: performance.now() - start,
        };
      }
      rows[i] = { item, answer };
      done += 1;
      if (options.parallel) process.stdout.write(`\r${checker.name}: ${done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: options.parallel ?? 1 }, worker));
  if (options.parallel) process.stdout.write('\n');
  return rows;
}

const runs: CheckerRun[] = [];
const engine = shadowHome(home);
const engineRows = await run(engine, { warmUp: true });
runs.push({ name: engine.name, metrics: score(engineRows), rows: engineRows });

if (argv.includes('--judge')) {
  const model = option('--judge-model') ?? JUDGE_MODEL;
  const homeJson = JSON.stringify(JSON.parse(readFileSync(homeFile, 'utf8')));
  const system = judgeSystemPrompt(homeJson);
  // An answer is reused only for the same model, instructions and plan.
  const key = (item: BenchItem) =>
    createHash('sha256')
      .update(`${model}\n${system}\n${judgeMessage(item)}`)
      .digest('hex');
  const cacheFile = join(reports, 'judge-cache.json');
  let cache: Record<string, Answer> = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, Answer>;
  } catch {}
  const fresh = items.filter((item) => !cache[key(item)]).length;
  console.log(
    `LLM judge on ${model}: ${fresh} model calls (${items.length - fresh} answers cached)`,
  );
  const judge = llmJudge(homeJson, { model });
  const judgeRows = await run(judge, { parallel: 3, cached: (item) => cache[key(item)] });
  for (const { item, answer } of judgeRows) if (!('error' in answer)) cache[key(item)] = answer;
  writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
  runs.push({ name: judge.name, metrics: score(judgeRows), rows: judgeRows });
}

// Twin mismatch: the same plans, judged on a house whose physics is off from the twin's, show
// how much each verdict leans on the exact constants.
const stress: StressRun[] = [];
if (argv.includes('--stress')) {
  for (const direction of ['colder', 'warmer'] as const) {
    const rows = await run(shadowHome(mismatchedHome(home, direction)));
    stress.push({ name: `${direction} by 20%`, metrics: score(rows), rows });
  }
}

writeFileSync(join(reports, 'report.md'), markdownReport(runs, skipped, stress));
writeFileSync(
  join(reports, 'results.json'),
  `${JSON.stringify(
    runs.map((r) => ({
      checker: r.name,
      metrics: r.metrics,
      answers: r.rows.map((s) => ({ id: s.item.id, expected: s.item.label.expected, ...s.answer })),
    })),
    null,
    2,
  )}\n`,
);

for (const r of runs) {
  const m = r.metrics;
  console.log(
    [
      `${r.name}: ${pct(m.accuracy)} match the labels`,
      `  catch rate ${pct(m.catchRate)}, false blocks ${pct(m.falseBlock)}`,
      `  UNPROVEN precision ${pct(m.unprovenPrecision)}, recall ${pct(m.unprovenRecall)}`,
      `  repair success ${pct(m.repairSuccess)}, latency p50 ${Math.round(m.latencyMs.p50)} ms, p99 ${Math.round(m.latencyMs.p99)} ms`,
    ].join('\n'),
  );
}
for (const s of stress) {
  const missed = s.rows.filter((r) => r.item.label.expected === 'UNSAFE' && verdictIs(r, 'SAFE'));
  console.log(
    `House ${s.name}: ${pct(s.metrics.accuracy)} match the labels; unsafe plans called SAFE: ${missed.length}; false blocks ${pct(s.metrics.falseBlock)}`,
  );
}
console.log(`Report: ${join('bench/reports', 'report.md')}`);

if (argv.includes('--gate')) {
  // CI: every approved label still matches (a disagreement is fixed in the engine, or the label is
  // changed by hand with a reason, never left), and the engine stays inside the 500 ms budget.
  const m = runs[0]?.metrics;
  const problems = [
    ...(m && m.accuracy.n !== m.accuracy.of
      ? [`${m.accuracy.of - m.accuracy.n} plans disagree with their labels`]
      : []),
    ...(m && m.latencyMs.p99 >= 500
      ? [`p99 ${Math.round(m.latencyMs.p99)} ms is not under 500 ms`]
      : []),
  ];
  if (problems.length > 0) {
    console.error(`Gate failed: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else console.log('Gate passed: every label matches, p99 under 500 ms.');
}

function verdictIs(s: Scored, verdict: string): boolean {
  return !('error' in s.answer) && s.answer.verdict === verdict;
}
