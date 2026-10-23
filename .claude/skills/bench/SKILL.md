---
name: bench
description: Run ShadowBench and compare the result with the previous report
disable-model-invocation: true
---
1. Copy bench/reports/report.md and results.json aside if they exist, then run `npm run bench`.
   It writes bench/reports/report.md and bench/reports/results.json, replacing the last ones.
2. Compare it with the copy of the previous report. For each metric show previous → now:
   - catch rate on unsafe and invalid plans
   - false-block rate on safe plans
   - UNPROVEN precision and recall
   - latency p50 and p99 (target: p99 under 500 ms)
   - repair success (UNSAFE plans with a SAFE repaired version)
   - LLM-judge baseline on the same plans, if it ran
3. List every plan whose verdict changed since the last report, with plan ID, label, old and new verdict.
4. For each plan where the engine disagrees with its label, say which stage decided
   (lint, hygiene, simulate, rules) and the rule ID. Don't touch bench/labels/.
5. End with one line: the most important thing to fix next, or "no regressions".
