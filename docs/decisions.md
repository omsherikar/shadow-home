# Decisions

Calls made while building, with the reason, so later sessions don't re-argue them.
Newest last. Change one only with a written reason.

## Day 2 (Oct 13): twin, lint, hygiene

1. **Packages ship TypeScript source, no build step.** `exports` points at `src/*.ts` and imports use `.ts` extensions (`allowImportingTsExtensions`, `erasableSyntaxOnly`). Vitest, `tsc --noEmit` and Node 22's type stripping all run it as is.
2. **The twin's file loader is a separate entry, `@shadow-home/twin/node`.** The main entry stays free of `node:fs`, so the engine can import it and stay pure. `purity.test.ts` fails the build if engine source imports the Node entry, `node:*`, `fetch`, an AWS or LLM SDK, or reads the clock or `Math.random`.
3. **Parse, then lint.** zod checks shape only. Whether a device, attribute or value makes sense for this home is lint, so it becomes a finding with reason kind `invalid` rather than a thrown error.
4. **A group write is checked member by member.** "All lights to 30%" fails lint for each light without dimming. The plan is invalid as written; Day 4's repair search can drop the members that can't take it.
5. **Modes are `home` and `away` only**, the two the fixture and the plan use. Anything else fails lint as `unknown_mode`.
6. **Hygiene findings are warnings and never change the verdict on their own.** Writes at the same minute run in plan order. The simulation decides what actually happens; hygiene explains why a plan is fragile.
7. **`missing_reversal` covers unlocking a door and turning on a heat-producing plug.** A dishwasher or a light left on is not flagged: the dishwasher ends its own cycle, and lights are rules' business (R10). Hygiene doesn't count a routine as the reversal; whether Good night re-locks the door in time is for the simulation.
8. **`routine_collision` compares local minute of day**, because every routine is daily. A plan's routine pause hides a collision only when the routine's trigger falls inside `[now, pauseUntil)`.
9. **`stateOverrides` are bench scaffolding, not plan content.** `checkOverrides` validates them separately; a bad override is a broken test case and is never counted as an invalid plan the checker "caught".
10. **Record lookups keyed by plan input use `own()`/`hasOwn()`.** The property tests found a group named `toString` crashing lint, and an attribute named `constructor` passing it. zod already drops `__proto__` keys when parsing.
11. **An action the simulation can't reach is not a lint error, and it must never come back SAFE.** That covers an `at` after `planEnd` or beyond the 72-hour horizon. Nothing is wrong with the request; the engine just can't see that far. Day 3 rule: the simulation runs to the latest of `planEnd` and 12 h after the last action, capped at 72 h, and any action past the cap makes the verdict UNPROVEN.
12. **"The same time" means the same minute, the simulation's step.** `expandWrites` floors every action time to its minute, so writes at 20:00:00 and 20:00:30 conflict.
13. **A routine step at a minute before `now` has already happened.** With `now` = 22:30:20, Good night's 22:30 step already ran, so a write at now doesn't collide with it, and a pause added now doesn't stop it. A pause stops triggers inside `[now, pauseUntil)`; delayed steps of a run that started earlier still happen. The Day 3 simulator must follow the same rule.
14. **Several pauses of one routine: the last in plan order wins.** Hygiene flags it (`conflicting_pauses`, or `repeated_pause` when they agree).
15. **Read-only attributes have value domains in the cluster catalog** (`contact` open/closed, `smokeState` normal/warning/critical, `occupied` boolean, and so on). `attrDomain()` checks device state, rule conditions and overrides against them, so a rule typo like `contact: "Open"` fails validation instead of silently never matching.
16. **Overlapping presence windows that disagree are invalid** (`presence_windows_overlap`). Windows that agree, or only touch end to start, are fine.
17. **The home's `utcOffset` must look like `-06:00` and match `clock.now`'s offset.** The fixture is a fixed UTC-6; there is no daylight saving inside the demo window.

## Open for Day 3

- **P003 and the dishwasher demo beat are dated Jan 12–13, outside the forecast** (Jan 15 17:00 to Jan 18 00:00). Re-date them, or define what the simulator does without forecast data. The red-team agent flagged this too.
- **Plans whose `now` differs from the fixture's clock** (P014 starts Sat 18:30, the fixture's clock is Fri 17:45). Is the fixture state a snapshot at the plan's `now`, or does the twin first simulate forward to it?
- **Unknown sensors need three-valued logic that short-circuits.** R11 is "dishwasher on AND latch open"; with the dishwasher off it must be false even though the latch reading is untrusted (4 % battery), or every plan becomes UNPROVEN.
- **Staleness over simulated time.** `lastReportMinutesAgo` is relative to `now`. Decide whether a sensor counts as reporting during the simulation or ages as simulated time passes.
