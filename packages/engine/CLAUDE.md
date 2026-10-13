# packages/engine

The verdict engine. Pure function:
(home state, plan, rules, forecast, options) → { verdict, reasons, unknowns, repairs, tier, diff, timeline }.

## Rules for this package

- No imports from node:fs, node:net, fetch, any AWS or LLM SDK, or packages/server.
- No Date.now(), new Date() without an argument, or Math.random(). The caller passes `now` and the forecast.
- Every exported function has unit tests. Stage logic also gets fast-check property tests:
  - the same input always gives the same output
  - a plan with no actions is SAFE when the starting state breaks no rule
  - removing an action never turns SAFE into UNSAFE (unless that action prevented a violation)
- Tests may read bench/plans and bench/labels; they must never write to them.

## Stages (in order)

1. lint: device exists, command supported, value in range → else UNSAFE (reason kind "invalid")
2. hygiene: conflicting or repeated writes to one attribute, missing reversal, order-dependent timing
3. simulate: 1-minute steps through the plan's end (or 12 h after the last action), max 72 h.
   Existing routines run inside the simulation. Loop guard: 50 triggered actions per step.
   Three runs: nominal, pessimistic (UA × 1.2, forecast − 2 °C), optimistic (UA × 0.8, forecast + 2 °C).
4. rules: each check returns true | false | unknown over every step.
   unknown = sensor missing, silent > staleSensorMinutes, or battery < lowBatteryPercent.

## Verdict

- UNSAFE: any rule false in the nominal run, or lint failed
- UNPROVEN: nominal passes but pessimistic fails, or any check unknown
- SAFE: all three runs pass and every check is known

Rule priority (highest first): life-safety, security, device-protection, comfort.

## Heating model (per zone, per minute)

T[t+1] = T[t] + (P_heat + gains + Σ UA_couple·(T_other − T) − UA_out·(T − T_out)) · 60 / C

Thermostats are bang-bang with a 0.5 °C hysteresis. Parameters live in fixtures/demo-home.json.
