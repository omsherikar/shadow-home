# Getting started (do this once, Tue Oct 13)

1. **Put the repo on GitHub.** Unzip, then:
   ```bash
   cd shadow-home
   git init && git add -A && git commit -m "Starter kit: Claude Code setup, demo home, ShadowBench seed"
   ```
   Create an empty **public** repo called `shadow-home` on GitHub, without adding a README or licence (both are included), and push.

2. **Install.** You need Node 22 (`nvm use` reads `.nvmrc`). Then:
   ```bash
   npm install
   chmod +x .claude/hooks/*.sh   # if your unzip tool dropped the execute bit
   npm test && npm run lint && npm run bench
   ```
   The hooks are bash scripts. On Windows, run Claude Code inside WSL.

3. **Approve the starter labels.** Read each file in `bench/labels/` against its plan in `bench/plans/` and the rules in `fixtures/demo-home.json`. If you agree, set `"approvedBy": "om"` and today's date in `approvedAt`. If you don't, fix the label and say why in `rationale`. Only you edit this folder; Claude Code is blocked from it.

4. **AWS (us-east-1).**
   - Set up a named profile: `aws configure sso --profile shadow-home`.
   - In the Bedrock console, submit the Anthropic first-use form. Check that a Claude Haiku model and Claude Sonnet 4.6 are available.
   - Create a $20 budget alarm.

5. **Claude Code.** In the repo:
   ```text
   claude
   /plugin marketplace add modelcontextprotocol/ext-apps
   /plugin install mcp-apps@modelcontextprotocol-ext-apps
   /day 1
   ```
   Then press Shift+Tab for plan mode and ask for today's plan. Approve it once it's trimmed to the day's exit check.

6. **From Fri Oct 16**, once the server runs, let Claude Code call it while building:
   ```bash
   claude mcp add --transport http shadow-home http://localhost:3000/mcp
   ```

## What's already here

| Path | Contents |
| --- | --- |
| `CLAUDE.md`, `packages/engine/CLAUDE.md`, `packages/host/CLAUDE.md` | Project rules Claude Code loads automatically |
| `.claude/settings.json` | Allowed commands; blocks reading `.env` and editing `bench/labels/`; the two hooks |
| `.claude/hooks/` | After each edit: Biome + type-check the package. On stop: tests for changed packages (one retry, then it lets go) |
| `.claude/agents/` | `verifier`, `red-team`, `spec-checker` |
| `.claude/skills/` | `/day`, `/friction`, `/bench`, `/feedback` |
| `fixtures/demo-home.json` | The fictional home: 21 devices, 3 routines, 12 rules, 56-hour forecast. Tuned so the demo's weekend plan fails exactly as scripted |
| `fixtures/demo-script.json` | The four demo beats and what each should produce |
| `bench/` | ShadowBench format, 5 starter plans, 5 draft labels waiting for your approval |
| `docs/plan.md` | The full execution plan (exported from the planning doc) |
| `docs/friction-log.md` | Five real friction entries from today's research, plus the template |

Both hooks were tested before shipping:
- the edit hook catches a type error and a Biome lint error (exit 2)
- the stop hook catches a failing test, stops after one retry, and passes clean code
