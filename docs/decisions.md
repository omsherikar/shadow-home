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

## Simulation

18. **The fixture state is a snapshot at the plan's `now`.** Device states, zone temperatures and sensor ages (`lastReportMinutesAgo`) are read as of `now`, whatever the fixture's own clock says.
19. **Sensor trust is judged at `now` and holds for the whole run.** A device with a sensor block whose battery is under `lowBatteryPercent` or that has been silent for more than `staleSensorMinutes` is untrusted, and every reading from it is unknown. A trusted sensor stays trusted. Mains-powered devices without a sensor block are always trusted. A sensor override on a device with no sensor block is a broken test case (`checkOverrides`).
20. **A commanded state on an untrusted device counts when it breaks a rule, not when it would satisfy one.** Each rule is checked twice per step: once taking commanded values at face value, once with every untrusted reading unknown. If the first breaks the rule, the plan asked for a forbidden state, so it is a violation: switching off a smoke alarm whose battery is low is UNSAFE, not UNPROVEN. Otherwise the second decides, so locking a lock at 9 % battery with nobody home stays UNPROVEN: the lock may not have engaged.
21. **Rules use Kleene three-valued logic.** Unknown spreads only when the answer depends on it: R11, "dishwasher on AND latch open", is false while the dishwasher is off, even with the latch at 4 % battery.
22. **The heating model is the one in `packages/engine/CLAUDE.md`, stepped once a minute.** The starting zone temperature is its thermostat's reading. The pessimistic and optimistic multipliers apply to heat loss to the outdoors only, not to the coupling between zones; the forecast offset applies to every hour.
23. **Thermostats heat below setpoint − 0.5 °C and stop above setpoint + 0.5 °C.** This reproduces the fixture's reference run: the draft away plan's garage minimums (0.27, −2.08 and 2.64 °C) match exactly, and the times it first drops below 4 °C land one minute after the reference's, because we stamp the first minute that reads below 4 °C rather than the minute the crossing happens in.
24. **So a 4.5 °C garage setting is UNSAFE, not just unproven.** The heater only starts below 4.0 °C, so the garage dips a hair under the R3 limit in every run. 5 °C is the lowest setting that passes all three.
25. **In one minute, routine steps run first and plan actions after, in plan order, so the plan wins.** Only real changes are recorded on the timeline.
26. **The simulation runs from `now` to the latest of `planEnd`, 12 h after the last action, the end of the last presence window and the end of the last routine pause, capped at 72 h and at the end of the forecast.** The plan's effects last as long as the house is empty or a routine is paused, so "away until Sunday" is simulated to Sunday even without a `planEnd`. Any cut (by the cap or by the forecast), a `now` before the forecast, or an action after the end makes the verdict UNPROVEN. In those cases the heating model holds the nearest forecast point rather than guessing.
27. **The loop guard counts routine-triggered actions only.** Plan actions are bounded by the plan itself. Past 50 in one step, the rest are dropped and the verdict is UNPROVEN.
28. **`within_after` (R6) means: once the trigger has held for more than `minutes` consecutive steps, every `ensure` must hold.** So "within 1 minute of smoke" allows the response by the minute after the smoke appears.
29. **P003 and the dishwasher demo scenario were re-dated into the forecast window** (now Fri Jan 15 21:30, dishwasher Sat Jan 16 02:00). Their meaning is unchanged: R11 can't be checked while the latch reports 4 % battery.

## Verdict

30. **UNSAFE if lint fails or any rule breaks in the nominal run. UNPROVEN if the nominal run holds but another run breaks a rule (`not_robust`), or anything is unknown. SAFE only if every run holds and every check is known.** A definite violation outranks an unknown elsewhere.
31. **Reasons are ordered by kind (invalid, violation, not robust, unknown), then by rule priority (life safety, security, device protection, comfort), then by time.** That puts R8 (coffee maker on with nobody home, life safety) ahead of R1 (freezer) in the away plan, even though R1 breaks first.
32. **Each broken rule names its cause: the latest change, at or before the moment it broke, that pushed the rule toward breaking.** A change pushes toward breaking when it makes a condition true that the rule forbids (or false that it requires); for R3 any change to the garage thermostat counts. When what tipped the rule was not a change (everyone leaving with lights still on), there is no cause rather than a wrong one. The away plan's R8 cause is the Coffee at 7 routine; its R1 and R2 cause is the plan's "all plugs off"; its R3 cause is turning the garage heater off.
33. **Refuse rules (R12) are marked `refuse: true` on the reason** so the confirmation tier can refuse outright rather than offer a safe part.
