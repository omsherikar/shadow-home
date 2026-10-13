# Design decisions

Behaviour choices in the twin and the verdict engine, with the reason for each. Change one only with a written reason.

## Packaging

1. **Packages ship TypeScript source, with no build step.** `exports` points at `src/*.ts` and imports use `.ts` extensions (`allowImportingTsExtensions`, `erasableSyntaxOnly`). Vitest, `tsc --noEmit` and Node 22's type stripping all run the source as is.
2. **The twin's file loader is a separate entry, `@shadow-home/twin/node`.** The main entry stays free of `node:fs`, so the engine can import it and stay pure. `purity.test.ts` fails the build if engine source (or the twin's main entry) imports Node built-ins, `fetch` or an AWS or LLM SDK, or reads the clock or a random source.

## Input checking

3. **Parse, then lint.** zod checks shape only. Whether a device, attribute or value makes sense for this home is lint's job, so a bad one becomes a finding with reason kind `invalid` rather than a thrown error.
4. **Record lookups keyed by plan input use `own()` and `hasOwn()`.** Otherwise a group named `toString` crashes lint and an attribute named `constructor` passes it; the property tests found both. zod already drops `__proto__` keys when parsing.
5. **Read-only attributes have value domains in the cluster catalog**: `contact` is open or closed, `smokeState` is normal, warning or critical, `occupied` is a boolean, and so on. `attrDomain()` checks device state, rule conditions and state overrides against them, so a rule typo like `contact: "Open"` fails validation instead of silently never matching.
6. **The home's `utcOffset` must look like `-06:00` and match the offset of `clock.now`.** The demo home is a fixed UTC-6, with no daylight saving inside the demo window.
7. **`stateOverrides` are benchmark scaffolding, not plan content.** `checkOverrides` validates them separately. A bad override is a broken test case and never counts as an invalid plan the checker caught.

## Lint

8. **A group write is checked member by member.** "All lights to 30%" fails lint once for each light that can't dim. The plan is invalid as written; the repair search can later drop the members that can't take the value.
9. **Modes are `home` and `away` only**, the two the demo home uses. Anything else fails lint as `unknown_mode`.
10. **Overlapping presence windows that disagree are invalid** (`presence_windows_overlap`). Windows that agree, or only touch end to start, are fine.
11. **An action the simulation can't reach is not a lint error, but it must never come back SAFE.** That covers an `at` after `planEnd` or beyond the 72-hour horizon: nothing is wrong with the request, the engine just can't see that far. Requirement for the simulator: run to the later of `planEnd` and 12 h after the last action, capped at 72 h, and return UNPROVEN for any action past the cap.

## Hygiene

12. **Hygiene findings are warnings and never change the verdict on their own.** The simulation decides what actually happens; hygiene explains why a plan is fragile. Writes in the same minute run in plan order.
13. **`missing_reversal` covers unlocking a door and turning on a heat-producing plug.** A dishwasher or a light left on is not flagged: the dishwasher ends its own cycle, and lights are covered by rule R10. A routine doesn't count as the reversal; whether Good night re-locks the door in time is the simulation's question.
14. **"The same time" means the same minute, the simulation's step.** `expandWrites` floors every action time to its minute, so writes at 20:00:00 and 20:00:30 conflict.
15. **`routine_collision` compares local minute of day**, because every routine is daily.
16. **A routine step in a minute before `now` has already happened.** With `now` at 22:30:20, Good night's 22:30 step has run, so a write at `now` doesn't collide with it and a pause added at `now` doesn't stop it. A pause stops triggers inside `[now, pauseUntil)`; later steps of a run that started earlier still happen. The simulator must follow the same rule.
17. **When a plan pauses one routine more than once, the last pause in plan order wins.** Hygiene flags it as `conflicting_pauses`, or `repeated_pause` when the pauses agree.

## Open questions for the simulator

- **P003 and the dishwasher demo scenario are dated Jan 12–13, outside the forecast** (Jan 15 17:00 to Jan 18 00:00). Either re-date them, or define what the simulator does without forecast data.
- **Plans whose `now` differs from the fixture's clock.** P014 starts Sat 18:30, while the fixture's clock reads Fri 17:45. Is the fixture state a snapshot at the plan's `now`, or does the twin first simulate forward to it?
- **Unknown sensors need three-valued logic that short-circuits.** R11 is "dishwasher on AND latch open". With the dishwasher off, it must be false even though the latch reading is untrusted (4 % battery); otherwise every plan becomes UNPROVEN.
- **Sensor staleness over simulated time.** `lastReportMinutesAgo` is relative to `now`. Decide whether a sensor keeps reporting during the simulation or ages as simulated time passes.
