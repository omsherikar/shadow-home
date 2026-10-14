# Shadow Home — Execution Plan & Stack

Oct 13, 2026 · @Om Sherikar · Amazon Developer Hackathon, Alexa+ track · Deadline Sat Oct 24, 12:30 AM IST (Oct 23, 12:00 PM PDT)

## Approach: then vs now

The thesis stayed the same: check what an AI agent wants to do before it lands. What changed is how we check, what we promise, and how we prove it.

| Area | Earlier (v1) | Now (v2) | Why it changed |
| --- | --- | --- | --- |
| Positioning | "Refactron for your house", pitched as new | The first system to combine forward-in-time home simulation, compiled house rules, a three-valued verdict and an MCP gate. Cite the closest prior work | The parts already exist ([Sentinels](https://pure.psu.edu/en/publications/using-sentinels-and-digital-twins-to-secure-agentic-ai-in-iot-sys/), [Cordon](https://arxiv.org/abs/2606.17573), [AgentSpec](https://arxiv.org/abs/2503.18666)); this combination does not |
| How we check | House rules against a digital twin | 4 stages: lint, plan hygiene, simulation with the home's existing routines, rules over the timeline | [HomeBench](https://aclanthology.org/2025.acl-long.597/): GPT-4o 0% on invalid multi-device requests. iRuler: 66% of rule sets had conflicts between rules |
| UNPROVEN | A sensor is missing | Missing or stale sensor, low battery, or the verdict flips when physics or the forecast shifts ±20% | [VetIoT](https://arxiv.org/abs/2308.12417), [TwinGridShield](https://arxiv.org/abs/2608.15391): 20% model error let up to 30% of unsafe actions through |
| House rules | Plain words, an LLM turns them into checks | Fixed rule templates. Compile 3 times and keep a rule only if all agree. Read it back, simulate a sample day, check for conflicts. Loosening a rule needs the owner | [NOMOS](https://neurips.cc/virtual/2026/168205): 18–29% of decisions flipped by compiling model. AgentSpec: 71% recall |
| What we return | Verdict + explanation | Verdict, the broken rule, when it breaks, and a suggested fix, as structured fields | [VIRF](https://arxiv.org/abs/2602.08373): 0% hazardous with about 1 repair round. Alexa+ writes its own speech from your data |
| Undo | Undo anything | Each action tagged as holdable, compensable or irreversible; irreversible ones wait for the check | [GoEX](https://arxiv.org/abs/2404.06921), Atomix |
| Asking the user | Ask when unsafe | Six levels: act, one yes/no, block + safe part, one question, refuse | People approve 93% of prompts ([Anthropic](https://anthropic.com/engineering/claude-code-auto-mode)). [Alexa Haus](https://developer.amazon.com/en-US/alexa/alexa-haus/design-principles/be-trustworthy): confirm explicitly only when an error is costly |
| Explanations | Explain the problem | Say why, in the rule's own words, plus who set it. Never talk the user into an UNPROVEN plan | [Lim et al. CHI 2009](https://www.cs.cmu.edu/~byl/publications/lim_chi09.pdf): "why" raised understanding from 62% to 80% |
| Screen | A diff of the house | Before → after per room (5 rows or fewer), a timeline, and the chain when routines trigger routines | Outcome diffs beat syntax diffs (Zhao, CHI 2021) |
| Confirming | Mid-call question (elicitation) | Two calls: preview, then commit with a signed plan ID. `approve_plan` only on screen | [Alexa+ client](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html) declares only `roots` |
| AWS | Bedrock, Lambda, DynamoDB | Same, plus Cedar for who/when rules. AgentCore Policy as a second lock (stretch) | [AgentCore Policy GA](https://aws.amazon.com/about-aws/whats-new/2026/03/policy-amazon-bedrock-agentcore-generally-available/), Mar 2026 |
| Proof | The demo | ShadowBench: 120 hand-labelled plans, catch rate, false blocks, latency, and an LLM-judge baseline | [DESPITE](https://arxiv.org/abs/2604.18463): best planner makes dangerous plans 28.3% of the time |
| Open Source entry | Alexa+ readiness checker | ShadowBench; the checker becomes a stretch | More original and useful beyond the hackathon |
| Households | Not considered | Every rule and change records who made it; the log is text only | Geeng & Roesner, CHI 2019 |

## Scope

The must-have list is a working end-to-end demo with benchmark numbers. Everything in it is finished before anything in Should starts.

**Must (the demo fails without these)**

- A digital twin of one fictional home: 5 rooms, about 20 devices modelled on Matter clusters, plus an outdoor forecast fixture
- A simulator stepping 1 minute at a time through the plan's end (up to 72 hours), with a simple heating model and the home's existing routines installed
- The 4-stage check pipeline and 12 house rules taken from the IoTGuard and Soteria catalogs
- Three verdicts with repairs, returned as structured fields
- An MCP server with 7 tools over Streamable HTTP (spec 2025-11-25), p99 under 500 ms
- Preview, commit, undo and an activity log
- One MCP App view: the diff plus the timeline
- A simulated Alexa Next.js app: voice in, Bedrock reasoning, spoken reply, MCP App on screen, plus a scripted demo mode
- ShadowBench v1: 120 plans, the metrics, and an LLM-judge baseline
- README, licence, demo video, submission text

**Should**

- House rules written in plain words: compiled 3 times and kept only if all agree, read back, tested on a simulated sample day
- A compile-invariance test in ShadowBench (the same rules compiled by 3 models)
- A ±20% robustness band that feeds UNPROVEN
- Cedar for who-can-do-what-and-when permissions
- Deployed on Lambda and DynamoDB at a public URL
- Two household members, with every rule and change attributed to one of them

**Stretch**

- AgentCore Gateway and Policy as a second lock on `commit_plan`
- OAuth 2.1 with PKCE, to Alexa+'s published requirements
- MRTR confirmations for clients on spec 2026-07-28
- The Alexa+ readiness checker CLI

**Deliberately out**

- Real devices or a Home Assistant bridge (a fictional home is fine for judging)
- Deploying to real Alexa+ (partner-only)
- Full model checking with Spin or z3: too slow for 500 ms. We find rule conflicts by simulation instead
- More than one home, a mobile app, payments, cameras

## Architecture

Models plan, phrase and compile rules in the top zone. Every action then passes through the deterministic verdict engine in the bottom zone before it can run.

```text
LLMs plan and talk; only deterministic code decides

[Uses an LLM: plans, phrases, compiles]
  Person <-> Simulated Alexa   (Next.js, Echo Show look; Web Speech in, Polly out)
         <-> Voice gateway     (Next.js route handlers; Bedrock Converse loop; MCP client)
  Rule compiler                (Strands + Sonnet; 3 compiles must agree) --rules--> Store

        |  MCP over Streamable HTTP  (stretch: through AgentCore Gateway + Policy)
        v
[Deterministic: decides, never an LLM]
  MCP server      (7 tools, Hono on Lambda, signed plan IDs, MCP Apps diff view)
    <-> Verdict engine  (lint, plan hygiene, 3 simulations, rules, verdict + repairs)
          <-> Digital twin  (Matter-shaped home, routines, forecast, heating model)
    <-> Store       (DynamoDB or in-memory: plans, rules, log, undo tokens)

  ShadowBench (120 hand-labelled plans vs an LLM judge) --> Verdict engine, called directly
```

One request, end to end:

1. The person speaks. The web app turns speech into text and sends it to the voice gateway.
2. The gateway's model drafts a plan and calls `preview_plan` on the MCP server.
3. The server loads the home and its rules. The engine simulates the plan three times and returns a verdict, reasons, repairs and a confirmation tier.
4. The gateway speaks from the speech fields through Polly. The screen shows the diff and timeline from the MCP App.
5. On a yes, or a tap for T2 and T4, `commit_plan` applies the plan to the twin, writes the log and returns an undo token.

Latency targets: the engine under 200 ms, a full MCP round trip under 500 ms. The model's own thinking time is separate, just as it is on real Alexa+.

## Stack

The stack is TypeScript on Node 22 end to end, with every AWS piece optional at run time, so the demo and the judges never depend on a cloud call working. Versions are the latest on npm as of Oct 13, 2026. Pin them exactly in `package-lock.json`.

| Layer | Choice | Why it's the reliable pick | Fallback |
| --- | --- | --- | --- |
| Language, runtime | TypeScript 7.0, Node.js 22 LTS | One language everywhere. MCP Apps tooling is TypeScript-first, and Strands needs Node 22+ | TypeScript 6.0.3 if a tool breaks |
| MCP server | `@modelcontextprotocol/server` 2.3.1, `createMcpHandler` | Stable v2 line. Implements spec 2026-07-28 and by default also serves 2025-era clients (2025-11-25, and Alexa+'s 2025-03-26), one request at a time | v1 `@modelcontextprotocol/sdk` 1.32.1 |
| HTTP | Hono 4.13 + `@modelcontextprotocol/hono` 2.0.2 | The same app runs on Node locally and on Lambda via `hono/aws-lambda`. Host-header checks built in | Express adapter |
| On-screen UI | `@modelcontextprotocol/ext-apps` 2.0.3 | Alexa+ renders MCP Apps when a tool returns `resourceUri`. The same package gives our host the `app-bridge` | Our host draws `structuredContent` itself |
| Schemas | zod 4.6 | Required by the SDK. The same schemas validate rules, plans and tool input/output | — |
| Verdict engine, simulator | Our own TypeScript modules, no dependencies | Deterministic, unit-testable, fast. No LLM anywhere in the check path | — |
| Permissions (Should) | `@cedar-policy/cedar-wasm` 4.13 (Node build) | Amazon's policy language: deny by default, forbid wins, runs in-process | Our own rule format only |
| Simulated Alexa | `@modelcontextprotocol/client` 2.3.1 + Bedrock Converse API, a Claude Haiku-class model, inside Next.js route handlers | A loop of about 200 lines we fully control, so tool results and `_meta.ui` reach the screen | Scripted demo mode that replays recorded plans |
| Rule compiler, LLM-judge baseline | `@strands-agents/sdk` 1.20 + `BedrockModel` (Claude Sonnet 4.6) | Structured output, and Strands is named in the AWS Builder challenge | Direct Converse calls |
| Voice | Web Speech API (Chrome) in, Amazon Polly out | Speech-to-text needs no setup. Polly sounds like a real product | Typed input; browser `speechSynthesis` |
| Web app | Next.js 15.5 (App Router) + React 19 | Amplify Hosting officially supports Next.js 12–15. Route handlers on the Node runtime hold the voice gateway, so one app serves the screen and the Bedrock loop | Next.js 16.4 deployed with OpenNext (`@opennextjs/aws` 4.1.9) |
| MCP App views | React 19 + esbuild 0.28, one HTML file per view | The MCP server serves each view as a self-contained `ui://` resource, which Next.js can't output | — |
| Storage | In-memory adapter + DynamoDB (on-demand, one table) | Judges and tests run with no AWS account; same interface in both | — |
| Infrastructure | AWS CDK 2.273 for the MCP server (Lambda Node 22 + Function URL) and DynamoDB; Amplify Hosting for the Next.js app | `cdk deploy` plus a git-connected Amplify app | Run locally + a cloudflared tunnel |
| Second lock (Stretch) | AgentCore Gateway + Policy | An independent check that `commit_plan` follows a SAFE preview | Skip; the server-side check already blocks it |
| Testing | Vitest 5, fast-check 4.10, MCP Inspector 2.10, Playwright | Property tests on the engine, manual protocol checks, an end-to-end run of the demo script | — |
| Repo tooling | npm workspaces, Biome, GitHub Actions | `npm install` is all judges need. CI runs tests and ShadowBench on every push | — |

**Reliability rules**

1. Local first: `npm install && npm run dev` starts everything without AWS credentials, using a mock model.
2. Demo mode replays a fixed script, so the recorded demo never depends on model randomness.
3. No LLM in the check path, ever. Models only plan, compile rules and talk.
4. CI fails if the ShadowBench catch rate drops or p99 latency passes 500 ms.
5. One AWS region: us-east-1, for the widest Bedrock and AgentCore coverage.

**Check on day 1:** the Claude Haiku model ID available in us-east-1, the Anthropic first-use form in the Bedrock console, a Polly neural voice, whether AgentCore's time-based policies are usable, and an IAM role that lets Amplify's server-side code call Bedrock and Polly. [MCP v2 migration notes](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

## Repo layout and MCP tools

One public monorepo (Apache-2.0) holds the product. ShadowBench gets its own public repo for the Open Source entry, because that challenge asks for a new, additional project.

```
shadow-home/
  packages/
    twin/     home model: Matter-shaped devices, rooms, routines, forecast fixtures
    engine/   lint → hygiene → simulate → rules → verdict + repairs (pure, no I/O)
    rules/    rule templates, compiler (Strands), agreement check, read-back
    server/   MCP tools, MCP App resources, plan signing, storage adapters
    views/    MCP App views (diff + timeline), one HTML file each, built with esbuild
    host/     simulated Alexa: Next.js app; route handlers run the Bedrock loop and Polly
    infra/    CDK stack
  fixtures/   demo home, demo script, recorded plans
  docs/       architecture, research notes, friction log

bench/        ShadowBench, split into its own repo on Oct 21
  plans/      120 plans + hand labels
  adapters/   Shadow Home, LLM-judge baseline, any checker
  runner/     metrics, stress tests, report
```

Seven tools. Every response carries `structuredContent` that matches a declared `outputSchema`, plus one short text line for clients that only read text.

| Tool | Annotations | Takes | Returns |
| --- | --- | --- | --- |
| `get_home_state` | read-only, closed world | optional room | Devices, mode, who's home, active routines, how fresh each sensor is |
| `preview_plan` | read-only, closed world | actions (device, command, value, optional time), intent, who asked | Plan ID (signed, 5-minute expiry, tied to the home's state version), verdict, diff, timeline, violations, unknowns, repairs, safe-subset plan ID, speech fields; `_meta.ui.resourceUri` points at the plan view |
| `commit_plan` | destructive, idempotent by plan ID | plan ID, optional confirmation, optional "safe part only" | What was applied, what was held, undo token, log entry |
| `undo` | read-only | undo token or "last" | A new preview of the reversal, including what can't be reversed. It commits through `commit_plan`, so undo goes through the same checks |
| `get_activity_log` | read-only | time range, person, grouping | Entries with who, what, when, source, verdict and whether each can be undone |
| `add_house_rule` | not destructive | rule text, author | Compiled rule, read-back, sample-day result, conflicts, and "needs owner approval" if it loosens safety |
| `approve_plan` | visible to the on-screen app only | plan ID | Approval record. Only a tap on the screen can call it |

**Two safety details in the contract**

- `commit_plan` refuses an expired or tampered plan ID, and a plan whose home state changed since the preview. The user then gets a fresh preview instead of a stale approval.
- The speech fields (`headline`, `reason`, `ask`) are data Alexa speaks from, not a script. Each stays within one breath: about 15 words, or 25 when blocking or asking.

## Verdict engine

The engine is a pure function: (home state, plan, rules, forecast) → verdict, reasons, repairs and a confirmation tier, under 200 ms locally. It runs four stages in order and stops early only on a hard error.

1. **Lint.** Does each device exist, support the command, and get a value in range? This is the cheapest stage and catches the most (HomeBench: GPT-4o 0% on invalid multi-device requests).
2. **Plan hygiene.** Flag conflicting or repeated writes to one device, changes that are never reversed, and timing that depends on order (Soteria, Brackenbury).
3. **Simulate.** Step the twin 1 minute at a time, through the plan's stated end ("away until Sunday" runs to Sunday evening), or 12 hours after the last action when there's no end, up to 72 hours. The home's existing routines run inside the simulation, so routine-on-routine chains show up. A loop guard stops at 50 triggered actions per step.
4. **Evaluate rules** over every step of the timeline. Each check answers true, false or unknown.

**Heating model** (IoTSafe's simple model, plus the outdoor forecast it lacked), per room, per minute:

```latex
T_{t+1} = T_t + \frac{\eta P_{heat} - UA\,(T_t - T_{out,t})}{C}\,\Delta t
```

Each room gets fixed values for UA (heat loss) and C (heat capacity) in the fixture. The garage loses heat fastest.

**Rule format.** Five templates, after AutoTap. Plain-language rules compile into these and nothing else.

| Template | Example |
| --- | --- |
| `never X when Y` | Never unlock the front door 22:00–06:00 unless the owner is home |
| `always X` | The garage freezer plug is always on |
| `within k min after Y ensure X` | Within 1 min of smoke, the alarm sounds |
| `keep Q between a and b when Y` | Garage stays at or above 4°C |
| `never A and B together` | Heater and an open window |

Each rule stores its author, the original sentence, its priority and the hash the compilers agreed on. Priority order: life safety, then security, then device protection, then comfort. So "unlock for escape when there's smoke" beats "door locked at night" by design, not by accident.

**How the verdict is decided.** We run the simulation three times: nominal, pessimistic (heat loss +20%, forecast low −2°C) and optimistic.

- **UNSAFE:** any rule is false in the nominal run, or lint fails.
- **UNPROVEN:** the nominal run passes, but the pessimistic run fails, or any check comes back unknown. Unknown means a sensor is missing, silent for more than 10 minutes, or below 15% battery.
- **SAFE:** every run passes and every check is known.

**Repairs.** For each violation, try in order: leave out that device from a group action, move the value to the nearest one that passes (1°C steps), or drop the action. Every repaired plan is checked again and gets its own plan ID.

**Undo honesty.** Each action is tagged *holdable* (not yet fired, can be cancelled), *compensable* (state can be put back, the effect already happened) or *irreversible*. An irreversible action never runs without a SAFE verdict.

**Confirmation tier** returned with every verdict:

| Tier | When | What Alexa does | Example line |
| --- | --- | --- | --- |
| T0 | SAFE, reversible, comfort | Acts, offers undo | "Done. Living room dimmed to 30%." |
| T1 | SAFE, affects others | Acts, says who it affects | "Heat's 21 everywhere, including Sam's room." |
| T2 | SAFE but irreversible or security | One yes/no naming the consequence | "Unlock the front door for five minutes?" |
| T3 | UNSAFE | Blocks, cites the rule and author, offers the safe part | "Freezer stays on, per Om's rule. Do the rest?" |
| T4 | UNPROVEN | Does the proven part, asks one question | "Can't confirm the dishwasher door is latched. Run it anyway?" |
| T5 | Never allowed | Refuses | "I can't turn off smoke alarms." |

## ShadowBench

ShadowBench turns the demo into evidence: 120 hand-labelled plans run against Shadow Home and an LLM judge, with results on the demo's end card and in the README.

| Set | Plans | Example | Correct answer |
| --- | --- | --- | --- |
| Unsafe | 40 | "All plugs off" includes the freezer; heater on with a window open; door left unlocked at a scheduled time while away; pipe-freeze forecast | UNSAFE |
| Safe | 40 | Dim the lights, set 21°C, lock up at night | SAFE |
| Invalid | 20 | A device the home doesn't have; a value out of range | UNSAFE (lint) |
| Unprovable | 20 | Needs a sensor that's missing, stale or low on battery | UNPROVEN |

The unsafe set draws its hazard types from SafeAgentBench and Agent-SafetyBench, and its timing cases from SimuHome. Half of all plans are written by hand; the other half are generated by an LLM asked to produce risky plans, ToolEmu-style, then labelled by hand.

**Honesty rule:** labels are written before Shadow Home runs on them, by reading the plan, never by running the checker. TwinGridShield shows that labels made with the checker's own model only prove it agrees with itself.

**Metrics**

- Catch rate on unsafe and invalid plans
- False-block rate on safe plans (the cost to the user)
- UNPROVEN precision and recall
- Latency p50 and p99, against the 500 ms limit
- Repair success: the share of UNSAFE plans with a SAFE repaired version

**Baseline:** the same 120 plans judged by Claude Sonnet 4.6 on Bedrock, given the same home state and rules in its prompt.

**Stress tests (Should)**

- Compile invariance: compile the house rules with 3 different models and measure how often decisions differ (the NOMOS test)
- Twin mismatch: shift physics constants ±20% and measure how many unsafe plans now pass

No target numbers are set in advance. Whatever the results are, they're reported as measured.

## Day-by-day plan

The engine is done by Thu Oct 15, everything is on screen by Sun Oct 18, features freeze at the end of Tue Oct 20, and we submit by 6:00 PM IST on Fri Oct 23, six and a half hours before the deadline. Each day ends with an exit check. If it fails, the next day starts by fixing it and drops something from Should.

**Tue Oct 13 — Setup**

- [ ] Register on Devpost; join the Discord
- [ ] Create `shadow-home` and `shadowbench` (public, Apache-2.0): npm workspaces, Biome, Vitest, GitHub Actions
- [ ] AWS us-east-1: Anthropic first-use form in Bedrock, Haiku and Sonnet access, a $20 budget alarm
- [ ] Demo home fixture: 5 rooms, about 20 devices, 3 existing routines, a forecast with a −6°C night
- [ ] Start `docs/friction-log.md` and log every snag with a time

Exit: CI is green, and a script gets a reply from Bedrock.

**Wed Oct 14 — Twin, lint, hygiene**

- [ ] Twin types on Matter clusters (OnOff, Thermostat, DoorLock, BooleanState, OccupancySensing, power measurement), each with its Alexa interface name
- [ ] Lint and plan-hygiene stages, with unit tests
- [ ] Write and label the first 30 ShadowBench plans, before the engine can judge them

Exit: lint rejects every invalid plan written so far.

**Thu Oct 15 — Simulator and rules**

- [ ] 1-minute simulator, heating model, routines inside the simulation, loop guard
- [ ] The 12 catalog rules in the template format; true/false/unknown checks; priority order
- [ ] Three-run verdict (nominal, pessimistic, optimistic)
- [ ] Property tests: same input gives the same verdict; nothing that isn't SAFE commits without approval

Exit: "away for the weekend" comes back UNSAFE, citing the freezer, the aquarium, the Coffee at 7 routine and the garage pipes.

**Fri Oct 16 — Repairs and the MCP server**

- [ ] Repair search, safe-part plan IDs, reversibility tags, confirmation tiers
- [ ] MCP server: 7 tools on Hono + `createMcpHandler`, signed plan IDs, state-version check, in-memory store
- [ ] Test every tool in MCP Inspector on 2025-11-25 and 2026-07-28

Exit: preview → commit → undo works in Inspector, p99 under 200 ms locally.

**Sat Oct 17 — The screen**

- [ ] MCP App view: diff (5 rows or fewer), timeline, chain of causes, undo button, a voice equivalent for each control
- [ ] Simulated Alexa Next.js app: an Echo Show-style frame, MCP Apps rendered through `app-bridge`

Exit: a `preview_plan` call shows the diff and timeline in the host.

**Sun Oct 18 — Voice and reasoning**

- [ ] Voice gateway in Next.js route handlers (Node runtime): Bedrock Converse loop with the MCP client; speech fields to Polly; Web Speech API in; typed fallback
- [ ] Scripted demo mode that replays recorded plans
- [ ] Finish writing and labelling all 120 ShadowBench plans

Exit: the whole demo script runs by voice, and again in demo mode, with no manual steps.

**Mon Oct 19 — Plain-language rules and deploy (office hours 9:30 PM IST)**

- [ ] `add_house_rule`: Strands compiler ×3, agreement check, read-back, sample-day test, conflict check, owner approval for loosening
- [ ] `cdk deploy`: MCP server on Lambda + Function URL, DynamoDB adapter; the Next.js app on Amplify Hosting
- [ ] Office hours: ask whether Alexa+ supports elicitation in practice, how simulated hosts are judged, and whether ShadowBench fits the Open Source challenge

Exit: the deployed URL passes the same Inspector checks, p99 under 500 ms when warm.

**Tue Oct 20 — Benchmark and hardening (feature freeze tonight)**

- [ ] ShadowBench runner, metrics, LLM-judge baseline, report
- [ ] Stress tests, if on schedule
- [ ] Two household members; text-only activity log
- [ ] Fix what the benchmark exposes; CI gates on catch rate and latency

Exit: the report is generated. No new features after today.

**Wed Oct 21 — Demo and docs**

- [ ] README: one-command run, architecture, research basis, ShadowBench results, known limits
- [ ] Record the demo in demo mode (2:45 or less), add captions, upload to YouTube as public
- [ ] Playwright runs the demo script in CI

Exit: someone else has watched the video once.

**Thu Oct 22 — Submission writing**

- [ ] Description, and a note that all code is new this hackathon
- [ ] Product feedback for each tool used (MCP SDK v2, ext-apps, Inspector, Bedrock, Strands, Polly, CDK, Lambda, DynamoDB, Cedar, AgentCore if used)
- [ ] Friction log entries with severity; feature requests
- [ ] AWS Builder fields; Open Source fields

Exit: every Devpost field is filled in a draft.

**Fri Oct 23 — Buffer and submit**

- [ ] Fresh-clone test: follow the README on a clean machine
- [ ] Submit by 6:00 PM IST
- [ ] Keep the stack up through judging (Nov 9–20), or make sure the local run is documented

## Building it with Claude Code

Claude Code writes the code; you own the plan, the benchmark labels and the final words. Each day is one main session that starts in plan mode, with tests and ShadowBench deciding when work is done, and at most one parallel lane in a git worktree.

**One-time setup (Tue Oct 13, about an hour)**

1. Export this doc as Markdown to `docs/plan.md`, so every session can read the plan.
2. Run `/init`, then replace the result with the `CLAUDE.md` below (under 200 lines). Add a short `CLAUDE.md` in `packages/engine` and `packages/host` for their local rules.
3. Commit `.claude/settings.json` (below): allow test, lint, build and bench commands; block reading `.env` and editing benchmark labels.
4. Add two hooks: after every Edit or Write, type-check and lint the changed file; on Stop, run the tests for the touched package. A failing check exits 2, so the error goes back to Claude.
5. Install the MCP Apps skills: `/plugin marketplace add modelcontextprotocol/ext-apps`, then `/plugin install mcp-apps@modelcontextprotocol-ext-apps`.
6. From Fri Oct 16, connect our own server so Claude Code can call it while building: `claude mcp add --transport http shadow-home http://localhost:3000/mcp`.
7. Keep ShadowBench in `bench/` in the monorepo, with labels in `bench/labels/`. On Oct 21, publish it as its own repo with `git subtree split --prefix bench`, which keeps its history.
8. Add `.claude/worktrees/` and `CLAUDE.local.md` to `.gitignore`.

```markdown
# Shadow Home

An MCP server that checks a voice assistant's smart-home plans before they run:
diff → simulate on a digital twin → house rules → SAFE / UNSAFE / UNPROVEN.
Full plan: docs/plan.md (read only the section for today's task).

## Non-negotiables
- packages/engine is pure TypeScript: no I/O, no network, no LLM SDK imports,
  no Date.now() or Math.random(). Time and seeds are passed in.
- Same input, same verdict. Every engine change ships with a test.
- Never edit bench/labels/. If a label looks wrong, stop and tell me.
- Never weaken a test or a rule to make it pass. Explain the failure instead.
- MCP results: structuredContent matches outputSchema; p99 round trip < 500 ms.
- Speech fields: headline <= 15 words; reason and ask <= 25 words.

## Commands
- npm run dev       everything locally, in-memory store, mock model
- npm test          Vitest, all workspaces
- npm run bench     ShadowBench report to bench/reports/
- npm run inspect   MCP Inspector against localhost:3000/mcp

## Map
packages/twin, engine, rules, server, views (esbuild), host (Next.js 15.5), infra (CDK)

## Style
TypeScript strict. zod for all external input. Biome. Small commits that say what and why.
```

```json
{
  "permissions": {
    "allow": ["Bash(npm test:*)", "Bash(npm run test:*)", "Bash(npm run lint:*)",
              "Bash(npm run build:*)", "Bash(npm run bench:*)", "Bash(git status)", "Bash(git diff:*)"],
    "deny": ["Read(./.env)", "Read(./.env.*)", "Edit(./bench/labels/**)", "Write(./bench/labels/**)"]
  },
  "hooks": {
    "PostToolUse": [{ "matcher": "Edit|Write",
      "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/check-file.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/test-changed.sh" }] }]
  }
}
```

**Subagents** (`.claude/agents/`)

- `verifier` (Read, Grep, Glob, Bash): runs tests and ShadowBench, reports regressions, changes no code.
- `red-team` (Read and Write in `bench/plans/` only): drafts risky plans, ToolEmu-style. It never sees the engine code, so plans aren't shaped to pass. You write or approve every label.
- `spec-checker` (Read, Bash): checks every tool against the MCP spec and Alexa+'s published requirements, using MCP Inspector on both protocol versions.

**Project skills** (`.claude/skills/`)

- `/day <n>`: loads that day's tasks and exit check from `docs/plan.md`.
- `/friction <what happened>`: adds a dated friction-log entry in the format the judges want.
- `/bench`: runs ShadowBench and compares the result with the last report.
- `/feedback <tool>`: drafts product feedback for one tool from the friction log, for you to rewrite in your own words.

```markdown
---
name: friction
description: Log a friction entry for the hackathon submission
argument-hint: [what happened]
disable-model-invocation: true
---
Append to docs/friction-log.md a dated entry for: $ARGUMENTS
Fields: tool and version, task, steps taken, expected, actual,
severity (critical / major / minor), workaround, suggestion.
Ask me for any field you can't fill from this session.
```

**The daily loop**

1. Open `claude` in the repo, run `/day <n>`, switch to plan mode with Shift+Tab, cut the plan down, then approve it.
2. Engine work goes test-first: failing tests from the labelled plans, then code until they pass. The hooks check every edit.
3. Run `/code-review` on the diff before each commit. Commit small; a commit is your real checkpoint, because `/rewind` doesn't undo shell file operations.
4. Log snags with `/friction` the moment they happen. From Thu, end the day with `/bench` and the day's exit check.
5. `/clear` between unrelated tasks; `/compact` when context fills; `/rewind` to back out of a wrong direction.

**Sessions by day**

| Day | Main session | Parallel lane (`claude -w <name>`) |
| --- | --- | --- |
| Tue 13 | Setup: CLAUDE.md, settings, hooks, CI, fixtures | — |
| Wed 14 | Twin types; lint and hygiene, test-first | `bench`: red-team drafts 30 plans; you label them |
| Thu 15 | Simulator, rules, three-run verdict | — (the engine has one owner) |
| Fri 16 | Repairs; MCP server and 7 tools | `spec-checker` runs Inspector on both protocol versions |
| Sat 17 | MCP App view in `views/` | `host`: the Next.js app shell and `app-bridge` |
| Sun 18 | Voice gateway route handlers; demo mode | `bench`: 90 more plans drafted; you label them |
| Mon 19 | Rule compiler with Strands | `infra`: CDK for the server, Amplify for the Next.js app |
| Tue 20 | ShadowBench runner, baseline, fixes | — |
| Wed 21 | README, Playwright end-to-end, subtree split | You record the video |
| Thu 22 | `/feedback` drafts from the friction log | You rewrite them in your voice |
| Fri 23 | `claude -p "Follow the README from a fresh clone and report every step that fails"` | You submit |

A starter prompt for Wed:

```
/day 2
Read CLAUDE.md and the "Verdict engine" section of docs/plan.md.
Today: the lint and plan-hygiene stages in packages/engine.
Write failing tests from bench/plans and bench/labels first, then implement until they pass.
If a label looks wrong to you, stop and show me; don't change it.
```

**Keep these for yourself:** every benchmark label, the house-rule priority order, the demo script, and the final product feedback and description. Claude Code can draft all of them, but the judges are reading for your judgement. Keep AWS credentials in a named profile, never in the repo. [Claude Code docs](https://code.claude.com/docs/en/memory)

## Demo script

The demo runs 2:50 and puts the strongest moment, the blocked weekend plan, in the first minute. Record it in demo mode at 1080p with captions, your own voice and no third-party music or footage.

| Time | What happens | What it proves |
| --- | --- | --- |
| 0:00–0:15 | Hook: "The best AI planners make dangerous plans 28% of the time. Alexa+ is starting to run homes. Shadow Home checks every plan before it lands." | The problem, with a number |
| 0:15–0:55 | "I'm away for the weekend, set the house to away." The diff and timeline appear. UNSAFE: "all plugs off" includes the freezer and the aquarium, the Coffee at 7 routine would switch the coffee maker on with nobody home, and the garage drops below 4°C at 10:36 PM Saturday and nears freezing by Sunday morning. Alexa: "Done, except the freezer and aquarium stay on, Coffee at 7 is paused, and the garage heater holds 5°C so the pipes don't freeze." | Simulation forward in time, repairs, rule attribution |
| 0:55–1:20 | "Run the dishwasher at 2 AM when power's cheap." The latch sensor is at 4% battery. Alexa: "I can't confirm the dishwasher door is latched. Run it anyway?" | UNPROVEN: it knows what it doesn't know |
| 1:20–1:50 | "Never unlock the front door between 10 PM and 6 AM unless I'm home." Read-back, a simulated sample day, then a conflict with the smoke-escape rule, settled by the priority order | Plain-language rules made safe |
| 1:50–2:15 | Sunday: "What did you change while I was away?" The log, grouped by cause. "Undo the thermostat." The undo shows its own preview, then applies | Trust after the fact |
| 2:15–2:35 | How it works: the architecture diagram. No LLM in the check path, three simulations, measured latency | Tech implementation |
| 2:35–2:50 | ShadowBench results next to the LLM-judge baseline. End card: repo link and the AWS services used | Evidence, AWS Builder |

The example lines above are placeholders: the real lines come from the recorded run, and the numbers from the real ShadowBench report.

## Submission checklist

Every item below comes from the [hackathon rules](https://amazonappdev2026.devpost.com/) and [FAQ](https://amazonappdev2026.devpost.com/details/faqs). Both repos are public with a licence file, so no reviewer invitations are needed.

**Required**

- [ ] Text description: what it does and how it works
- [ ] GitHub repo: public, Apache-2.0 `LICENSE`, all source, assets and run instructions
- [ ] MCP really called in code: the server entry point and tool registrations are in the repo, not just named in the README
- [ ] Demo shows the MCP server working: the web host sends initialize, tools/list and tools/call over Streamable HTTP (the FAQ says this is enough)
- [ ] Video under 3 minutes, YouTube, public, English, no third-party trademarks or music
- [ ] Product feedback for every tool used: what for, what worked, what needs work, onboarding, would you build with it again. AWS services are described here too
- [ ] Track: Alexa+. Mini challenges: AWS Builder and Open Source
- [ ] Note that the project is new this hackathon, with no earlier code

**AWS Builder**

- [ ] README section listing each AWS service, what it does, and the file that calls it (Bedrock, Strands, Polly, Lambda, DynamoDB, CDK, plus AgentCore if built)

**Open Source**

- [ ] `shadowbench` repo URL, its licence, your GitHub username
- [ ] A short description of what it is, how it works and why it matters
- [ ] All of it created between the start of the hackathon and Oct 23

**Optional, worth doing**

- [ ] Friction log (up to a 10% judging bonus): for each entry, the task, the steps, expected vs actual, severity, workaround and a suggestion
- [ ] Feature requests, each with why and urgency. Starting list from the research:
  - Open the Alexa+ web simulator to hackathon entrants (critical)
  - A per-call preflight or dry-run hook for add-ons, like the draft MCP proposal SEP-1862 (important)
  - Safety and confirmation fields in the Smart Home AI Toolkit; today `verificationsRequired` is Japan-only (important)
  - The Alexa+ client declaring elicitation if it supports it (nice-to-have)

## Risks and fallbacks

The biggest risk is scope. When a day's exit check fails, drop Should items in this order: stress tests, Cedar, deployment (use a tunnel), then plain-language rules (ship the catalog rules only).

| Risk | Likelihood | Fallback |
| --- | --- | --- |
| Solo build runs over | High | Daily exit checks and the drop order above |
| Lambda cold starts break 500 ms | Medium | Provisioned concurrency of 1 while recording and judging; report warm and cold latency separately |
| MCP Apps rendering in our host fails | Medium | The host draws `structuredContent` itself; the `ui://` resource still ships for Alexa+ |
| Amplify doesn't support Next.js 16, Edge runtime or streaming | Known | Stay on Next.js 15.5, the Node runtime and non-streamed responses; OpenNext on CDK if 16 is needed |
| Bedrock access is delayed | Low | An Amazon Nova model as backup; mock model for development |
| Voice input is flaky on camera | Medium | Demo mode with typed input and Polly speech |
| Rule compilers keep disagreeing | Medium | That's the design working: reject and ask to rephrase. The demo uses a rule tested beforehand |
| "Real Alexa+ wouldn't route through an add-on" | Medium | Pitch it as the add-on a smart-home or security brand ships, plus a feature request; cite Alexa's own confirmation guideline |
| The twin's physics is simplified | Certain | The ±20% band feeds UNPROVEN; limits stated in the README; stress test |
| Similar entries | Medium | Lead with what others lack: time simulation, UNPROVEN, ShadowBench numbers |
| AWS costs with no credits | Certain | Free tier, a $20 budget alarm, tear down after Nov 20 |
| The name "Shadow Home" is taken | Unknown | Check before the video; fictional brands for every device in the demo |

## Sources

- [Hackathon overview and rules](https://amazonappdev2026.devpost.com/), [FAQ](https://amazonappdev2026.devpost.com/details/faqs), [Resources](https://amazonappdev2026.devpost.com/resources)
- [Alexa+ MCP quickstart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html), [Alexa+ MCP client lifecycle](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html)
- [MCP spec 2026-07-28: multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr), [MCP TypeScript SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28), [MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/)
- Package versions: npm registry, read Oct 13, 2026
- Research: [SimuHome](https://arxiv.org/abs/2509.24282), [DESPITE](https://arxiv.org/abs/2604.18463), [NOMOS](https://neurips.cc/virtual/2026/168205), [Cracking IoT Security](https://arxiv.org/abs/2601.00559), [IoTGuard](https://ndss-symposium.org/ndss-paper/iotguard-dynamic-enforcement-of-security-and-safety-policy-in-commodity-iot), [IoTSafe](https://par.nsf.gov/servlets/purl/10399983), [AutoTap](https://homes.cs.washington.edu/~jessejm/data/ZhangICSE2019.pdf)
