---
name: bench
description: Run ShadowBench and compare the result with the previous report
disable-model-invocation: true
---
1. Run `npm run bench`. It writes a dated report to bench/reports/.
2. Compare it with the previous report in bench/reports/. For each metric show previous → now:
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
