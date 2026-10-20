# Fixtures

## demo-home.json

A fictional home, "Cedar Hollow", used by the demo, the tests and ShadowBench. Generic devices, no real brands.

**Units.** Celsius, watts, joules per kelvin, minutes. Times are local, UTC−6.

**Clock.** `clock.now` is Fri 2027-01-15 17:45. Everyone is home. The weekend-away scenario has them leave at 18:00 and return Sun 18:00.

**What's inside**

| Part | Count | Notes |
| --- | --- | --- |
| Rooms | 5 | Four in the `house` zone, plus the `garage` zone |
| Thermal zones | 2 | House: UA 300 W/K, C 1.2e7 J/K, 12 kW furnace. Garage: UA 40 W/K, C 1.8e6 J/K, 1.5 kW heater. House↔garage coupling 10 W/K |
| Devices | 21 | Matter device type and clusters, Alexa interface names, capabilities with ranges, state, sensor battery and freshness |
| Groups | 3 | `all_plugs` (includes the freezer and aquarium on purpose), `all_lights`, `indoor_lights` |
| Routines | 3 | Good night 22:30, Coffee at 7 (07:00, off after 30 min), Porch light 17:30 (off after 330 min) |
| House rules | 12 | Five templates, authors, priorities, and the published catalog each one comes from |
| Forecast | 80 hourly points | Fri 17:00 → Tue 00:00, so a check on Sunday evening can still see 12 hours ahead. Lows: 0 °C Sat 05:00, −6 °C Sun 05:00, −3 °C Mon 05:00. Interpolate linearly between hours |

**Deliberate traps for the demo and the benchmark**

- `all_plugs` sweeps in the garage freezer (R1) and the aquarium heater (R2).
- The "Coffee at 7" routine turns the coffee maker on while nobody is home (R8), unless it's paused.
- With the garage heater off, the garage falls below 4 °C on Saturday night (R3).
- `dishwasher_latch` is at 4 % battery, so R11 can't be checked → UNPROVEN.
- R6 (smoke → unlock the front door) is life-safety, so it outranks any security rule that keeps the door locked.
- R12 is a refuse rule: no plan may disable the smoke alarm.

Device IDs, cluster names, and the Matter device type IDs given here (0x0100, 0x0101, 0x010A, 0x000A, 0x0015, 0x0107, 0x0301) were checked against matter.js. Devices with `"deviceTypeId": null` and a `verify` note still need checking.

## Reference results

A throwaway reference simulation, run on this fixture before any engine code existed. It used the heating model in packages/engine/CLAUDE.md, 1-minute steps from Fri 17:45 to Sun 18:00, and linear interpolation of the forecast. These numbers are a sanity check for the TypeScript engine, **not labels**.

| Plan | Run | Rules broken (first time) | Garage minimum |
| --- | --- | --- | --- |
| Draft "away" plan | nominal | R1 Fri 17:45, R2 Fri 17:45, R8 Sat 07:00, R3 Sat 22:36 | 0.27 °C |
| Draft "away" plan | pessimistic | R1, R2, R8 Sat 07:00, R3 Sat 02:42 | −2.08 °C |
| Draft "away" plan | optimistic | R1, R2, R8 Sat 07:00, R3 Sun 03:56 | 2.64 °C |
| Repaired plan | all three | none | 4.49 °C |

The draft plan: house thermostat 10 °C, garage heater off, all plugs off, all lights off, both doors locked.

The repaired plan is the same, except:
- the freezer and aquarium stay on
- Coffee at 7 is paused until Sun 18:00
- the garage heater is set to 5 °C

A garage setting of 4.5 °C still fails the pessimistic run (minimum 3.99 °C), so **5 °C is the lowest setting that passes**.

## demo-script.json

The five demo beats: what the person says, the scenario context, and the outcome we expect. `recordedPlan` stays null until Sun Oct 18, when demo mode records the plans the model actually drafted.

The last beat, "I'm heading out." on Monday at 7:15 AM, checks the house as everyone leaves (decision 100): Coffee at 7 still has the coffee maker on, R8 breaks, and a yes switches it off.
