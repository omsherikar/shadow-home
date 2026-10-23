# Shadow Home

**Alexa can suggest. Shadow Home checks.** An MCP server that dry-runs a voice assistant's smart-home plan on a digital twin of the house before anything happens. It returns SAFE, UNSAFE or UNPROVEN, says why in one breath, offers a safe fix, and keeps an undo log.

There is no LLM in the check path. Models draft plans, compile house rules and talk; the verdict comes from deterministic code, so the same plan on the same home always gets the same answer.

- **Try it:** https://shadowhome.omstudio.tech, a simulated Echo Show with a 3D model of the house beside it. Type, tap a suggestion, or turn on hands-free and say "Alexa". The MCP server is at https://mcp.shadowhome.omstudio.tech/mcp. Every visitor shares one house, which resets every day at 08:00 UTC.
- **Run it:** Node 22, then `npm install` and `npm run dev` (no keys needed), or `npm run demo` to add "Play the demo", the scripted demo start to finish with no model calls. See [Run it](#run-it).

Built for the Amazon Developer Hackathon, Alexa+ track (Oct 13 to 23, 2026). All code is new this hackathon.

## What it does

"I'm away for the weekend, set the house to away." The assistant drafts a plan: all plugs off, garage heating off, heat down, doors locked. Shadow Home runs it forward on the twin, against the weather forecast and the home's own routines, and finds:

- the garage freezer and the aquarium heater are plugs too, so "all plugs off" turns them off;
- the Coffee at 7 routine still fires on Saturday morning with nobody home;
- with the garage heating off, the forecast's −6 °C night takes the garage below 4 °C, where its pipes can freeze.

It answers UNSAFE, names the broken rules and who set them, and offers the plan with four fixes: keep the freezer and the aquarium on, pause Coffee at 7, hold the garage at 5 °C. A yes runs the fixed plan; "undo the thermostat" later puts back just that.

"I'm heading out" needs no plan at all: Shadow Home checks the house as it stands with nobody in it, says what to see to first ("Before you go: Bedroom space heater on and Back door lock unlocked."), and a yes adds the missing steps.

If a plan sets the house to away without saying who is away, the rules for an empty house can't be checked, so the plan is UNPROVEN and Alexa asks "Who's away, and until when?". It won't run until a new preview says who.

Three answers, never a guess:

| Verdict | Means |
| --- | --- |
| SAFE | Every rule holds for the whole plan, in all three simulations, and everything the rules need is known. |
| UNSAFE | A rule breaks in the expected run, or the plan uses something the home doesn't have. |
| UNPROVEN | It might be fine, but Shadow Home can't confirm it: a sensor is missing, silent or low on battery, or the plan holds only if the house loses heat exactly as expected. |

House rules can be added in plain words ("Never unlock the front door between 10 PM and 6 AM unless I'm home"). Three different models translate the sentence into one of five rule templates, and the rule is kept only if all three agree. Shadow Home reads it back, tries it on a simulated day, and reports conflicts with existing rules.

## How it works

```text
Models plan, phrase and compile rules; only deterministic code decides.

[Uses a model]
  Person <-> Simulated Echo Show  (Next.js; browser speech in, ElevenLabs voice out)
         <-> Voice loop           (route handlers; Claude Haiku 5.5; MCP client)
  Rule compiler                   (three Strands agents on Claude; must agree)

        |  MCP over Streamable HTTP
        v
[Deterministic: no model]
  MCP server      (7 tools, signed plan IDs, MCP App diff and timeline view)
    <-> Verdict engine  (lint, plan hygiene, 3 simulations, rules over the timeline, repairs)
          <-> Digital twin  (Matter-shaped devices, routines, forecast, heating model)
    <-> Store       (in memory locally; Firestore deployed)
```

1. The person speaks; the Echo Show page turns speech into text.
2. The voice loop's model drafts a plan and calls `preview_plan`.
3. The engine lints the plan, checks its hygiene (conflicting writes, missing reversals), then simulates the house minute by minute three times: as expected, 20% leakier with a forecast 2 °C colder, and 20% tighter and 2 °C warmer. Every house rule is checked at every step.
4. The device says the engine's verdict and question word for word, with the model's own explanation between them; a sentence of the model's that claims a verdict, an action or a device's state, or asks something or gives a number after a check, is dropped (`packages/host/src/turn/guard.ts`). The screen shows the diff and timeline. Beside it, a 3D model of the house shows the twin's live state: lights, plugs, locks, windows, who is home and both zones' temperatures. Each checked plan plays forward there in a shadow twin of the house, the engine's own run with every rule breaking at its time, then again with the fixes, under a timeline you can pause, speed up and drag.
5. A yes (or a tap) calls `commit_plan` with the signed plan ID. A SAFE plan commits; one that needs a yes commits only with it; an UNSAFE plan never commits, though its fixed version can. "Undo" is previewed and committed by the same rule.

On the page:

- **Chat.** A text box, a mic and suggestions are always on the page. Each turn streams as it happens (Server-Sent Events): Alexa's words, and a step for each tool call as it runs and returns.
- **Voice.** Alexa says each sentence as soon as it's finished, one ElevenLabs clip per sentence, played in order. Without an ElevenLabs key the browser speaks.
- **Hands-free.** One tap on "Start hands-free", then say "Alexa" and the request. When she asks a question, answer by voice with no wake word. It uses the browser's speech recognition, so it needs Chrome; typing works everywhere.

Alexa+ declares only the `roots` capability, so Shadow Home doesn't rely on mid-call questions: every change is a preview, then a commit with a signed, short-lived plan ID tied to the home's state.

The server speaks MCP over Streamable HTTP at `/mcp`: protocol version 2026-07-28, and, statelessly, 2025-era clients (2025-11-25, and 2025-03-26, which Alexa+ sends). It has 7 tools:

| Tool | Does |
| --- | --- |
| `preview_plan` | Checks a plan; returns the verdict, reasons, diff, timeline, repairs, a safe part, a confirmation tier and speech. Read-only. |
| `commit_plan` | Applies a previewed plan by its ID; destructive, and idempotent by plan ID. |
| `undo` | Previews putting things back, including what can't be undone. Read-only; the undo itself is committed with `commit_plan`. |
| `get_home_state` | Devices, mode, who's home, sensor freshness. Read-only. |
| `get_activity_log` | Who changed what, when, why, and whether it can be undone. Read-only. |
| `add_house_rule` | Compiles a rule in plain words; read-back, sample day, conflicts. |
| `approve_plan` | The on-screen yes. It needs a token only the screen receives, so a model can't approve for the person. |

## Try it live

- The Echo Show: https://shadowhome.omstudio.tech
- The MCP server: https://mcp.shadowhome.omstudio.tech/mcp. Any MCP client can use it, for example
  `claude mcp add --transport http shadow-home https://mcp.shadowhome.omstudio.tech/mcp`.

Every visitor shares one demo home: what one person commits, the next person sees. It starts over from the fixture every day at 08:00 UTC. The live site runs the live model (Claude Haiku 5.5) within an hourly budget; past it, Alexa says to try later. "Play the demo" is not on the live site; run it locally with `npm run demo`.

## Run it

Node 22.

```bash
npm install
npm run dev        # MCP server on :3000, Echo Show on http://localhost:3001
```

No keys are needed: without them the Echo Show uses a scripted model that knows the demo requests, and the browser speaks. With `ANTHROPIC_API_KEY` (and optionally `ELEVENLABS_API_KEY`) in `.env` or `.env.local` at the repo root, `npm run dev` uses Claude Haiku 5.5 as the assistant, compiles house rules in plain words, and uses ElevenLabs as the voice. `MOCK_MODEL=1 npm run dev` keeps the scripted model even with a key. Setup in more detail: [docs/getting-started.md](docs/getting-started.md).

```bash
npm run demo       # the same, plus "Play the demo": the demo script start to finish, no model calls
npm test           # unit, property and integration tests
npm run e2e        # the Echo Show in a browser (Playwright)
npm run bench      # ShadowBench report in bench/reports/
npm run inspect    # MCP Inspector; point it at http://localhost:3000/mcp
```

Any MCP client works too. For example, with `npm run dev` running: `claude mcp add --transport http shadow-home http://localhost:3000/mcp`.

The live site runs on Google Cloud Run, with Firestore and Secret Manager (`npm run deploy`). The AWS version (Lambda, DynamoDB, Secrets Manager, CDK) is built and tested against DynamoDB Local, but not deployed: the account never activated. Both are in [docs/deploy.md](docs/deploy.md).

## ShadowBench

[ShadowBench](bench/) is 120 smart-home plans with hand-checked labels: 40 unsafe, 40 safe, 20 invalid and 20 that can't be proven safe. Any plan checker can be run on it; Shadow Home and an LLM judge are the first two.

| Metric | Shadow Home |
| --- | --- |
| Verdict matches the label | 120 of 120 |
| Catch rate (unsafe and invalid plans called UNSAFE) | 60 of 60 |
| False blocks (safe plans not let through) | 0 of 40 |
| UNPROVEN precision and recall | 20 of 20, 20 of 20 |
| Unsafe plans with a fix that checks SAFE (invalid plans get no fix) | 40 of 40 |
| Named every rule the label names, on right verdicts | 60 of 60 |
| Engine latency, warm, p50 / p99 / max | 5 ms / 50 ms / 67 ms |
| Full MCP round trip, p99 (a laptop, 50 runs, `scripts/latency.ts`) | 22 to 30 ms for a simple plan; 137 to 224 ms for the weekend plan with its repairs |

**Twin mismatch.** The same plans on a house whose physics is 20% off the twin's: on a colder house all 120 verdicts hold; on a warmer one 118 do, and no unsafe plan passes on either. The two that move (the garage heater set low, or off overnight) become UNPROVEN, not SAFE.

**Read these numbers with care.** 115 of the plans were drafted by a red-team agent asked to produce risky plans, 5 by hand. Every label was drafted by an assistant that read the plan, the home and the rules without running any checker, and each was approved by the owner. A model-written engine agreeing with model-drafted labels is partly the two agreeing with each other; an independent baseline helps, which is why the LLM judge exists. The judge (Claude Sonnet 5.5) is not in these numbers: it costs one model call per plan, and `npm run bench -- --judge` runs it.

## Known limits

- **The twin is simplified.** One heating model per zone, a fictional home, and a three-day forecast. The three runs turn physics error into UNPROVEN rather than a false SAFE, but they don't make the model exact.
- **No real devices.** The home is a fixture; a real bridge (Matter, Home Assistant) is future work.
- **The host is a simulation.** The Alexa+ web simulator isn't open to hackathon entrants, so a Next.js page plays the Echo Show. The MCP server is what an Alexa+ add-on would call.
- **Rule compiles take a few seconds** (5 to 9 in testing, three models at once) and come back "I'm not sure what that rule means" when the models read the words differently. That's the design: no guess is kept.
- **Repairs are offers.** A fix can add a step the plan left out, such as locking a door, and that may go against what the person wanted (leaving a light on to look home, for example). The person decides.
- **One shared house.** Every visitor of the live site, and every MCP client of the live server, uses the same home. It starts over every day at 08:00 UTC, so the demo forecast never runs out.
- **No sign-in.** The MCP endpoint is public; OAuth is future work. To bound what a public demo spends, live-model turns and speech have hourly caps per instance and per visitor, and rule compiles per instance.
- **Hands-free needs Chrome.** It uses the browser's speech recognition, which Chrome sends to Google. Elsewhere, type or tap.

## Services and SDKs

| What | Used for | Where |
| --- | --- | --- |
| MCP TypeScript SDK v2 | The server and the host's client | `packages/server/src/app.ts`, `packages/host/src/turn/mcp.ts` |
| MCP Apps (ext-apps) | The diff and timeline view, rendered in the host | `packages/views`, `packages/host/src/screen` |
| Anthropic API | The voice loop (`claude-haiku-5-5`); the three rule compilers (`claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5`); the LLM judge (`claude-sonnet-5-5`) | `packages/host/src/turn/anthropic.ts`, `packages/rules/src/strands.ts`, `bench/adapters/llm-judge.ts` |
| Strands Agents SDK | The rule compilers' structured output | `packages/rules/src/strands.ts` |
| ElevenLabs | The device's voice, one clip per sentence | `packages/host/src/turn/elevenlabs.ts`, `packages/host/app/api/speak/route.ts` |
| Web Speech API (Chrome) | Hands-free: the wake word and spoken answers | `packages/host/src/voice` |
| three.js, React Three Fiber, postprocessing | The 3D house beside the device; models, textures and light from Poly Haven (CC0, see [CREDITS.md](packages/host/public/house/CREDITS.md)) | `packages/host/src/house`, `packages/host/public/house` |
| Google Cloud Run, Firestore, Secret Manager, Cloud Build | The deployed server and host | `scripts/gcp/deploy.ts`, `packages/server/src/cloud-run.ts`, `packages/server/src/firestore-store.ts` |
| AWS Lambda, DynamoDB, Secrets Manager, CDK, Bedrock, Polly | The same, on AWS: tested on DynamoDB Local, not deployed (the account never activated) | `packages/infra`, `packages/server/src/lambda.ts`, `packages/server/src/dynamo-store.ts`, `packages/host/src/turn/aws.ts` |

## Research basis

- LLM planners make dangerous plans far more often than invalid ones: 28.3% for the best planner in [DESPITE](https://arxiv.org/abs/2604.18463).
- Home agents fail most on timing: the best model completed about 54% of [SimuHome](https://arxiv.org/abs/2509.24282) tasks, and GPT-4o got 0% on invalid multi-device requests in [HomeBench](https://aclanthology.org/2025.acl-long.597/).
- Which model compiles a rule changes decisions: 18 to 29% flipped in [NOMOS](https://neurips.cc/virtual/2026/168205). Hence three compilers that must agree.
- A twin that's 20% off let up to 30% of unsafe actions through in [TwinGridShield](https://arxiv.org/abs/2608.15391). Hence the three simulation runs and UNPROVEN.
- Rule templates follow [AutoTap](https://homes.cs.washington.edu/~jessejm/data/ZhangICSE2019.pdf); the 12 house rules come from the [IoTGuard](https://ndss-symposium.org/ndss-paper/iotguard-dynamic-enforcement-of-security-and-safety-policy-in-commodity-iot) and Soteria catalogs.
- Closest prior work: [Sentinels and digital twins](https://pure.psu.edu/en/publications/using-sentinels-and-digital-twins-to-secure-agentic-ai-in-iot-sys/), [Cordon](https://arxiv.org/abs/2606.17573), [AgentSpec](https://arxiv.org/abs/2503.18666). What Shadow Home adds is the combination: forward-in-time simulation with the home's own routines, compiled house rules, a three-valued verdict, and an MCP gate.

Design decisions, with the reasons and what was measured: [docs/decisions.md](docs/decisions.md). The full plan: [docs/plan.md](docs/plan.md).

## Layout

| Path | What it is |
| --- | --- |
| `packages/twin` | Home model: Matter-shaped devices with Alexa interface names |
| `packages/engine` | Verdict engine: lint, hygiene, three simulations, rules, repairs. Pure functions, no I/O |
| `packages/rules` | House rules in five templates; the plain-words compiler |
| `packages/server` | MCP server: 7 tools, MCP App resources, stores, Cloud Run and Lambda entries |
| `packages/views` | MCP App views: diff and timeline |
| `packages/host` | The simulated Echo Show: Next.js, the voice loop, the voice, and the 3D house beside it |
| `packages/infra` | Server bundles and the AWS CDK stack |
| `scripts/gcp` | The Google Cloud deploy |
| `scripts/` | `npm run dev` and `npm run demo`, the MCP contract check, latency and load tests |
| `bench/` | ShadowBench: plans, labels, adapters, runner |
| `fixtures/` | The fictional demo home and the demo script |

## License

Apache-2.0. See [LICENSE](LICENSE). Copyright 2026 the Shadow Home authors.
