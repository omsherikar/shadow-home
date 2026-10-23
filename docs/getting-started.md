# Getting started

Everything runs on a laptop with no cloud account and no keys.

## Install

You need Node 22 (`nvm use` reads `.nvmrc`). Then, at the repo root:

```bash
npm install
```

## Run it

```bash
npm run dev
```

This builds the MCP App views, then starts:

| Port | What |
| --- | --- |
| 3000 | The MCP server, at http://localhost:3000/mcp |
| 3001 | The simulated Echo Show, at http://localhost:3001 |

Locally the home is kept in memory, so it starts over when the server restarts. Ctrl-C stops both.

```bash
npm run demo
```

The same, plus a "Play the demo" button that replays the demo script (`fixtures/demo-script.json`) start to finish. It makes no model calls, even when a key is set.

## Keys (optional)

Without keys the Echo Show uses a scripted model that knows the demo requests, and the browser speaks. To use the live model and voice, put these in `.env` or `.env.local` at the repo root (both are git-ignored; `.env.local` wins):

- `ANTHROPIC_API_KEY`: the live assistant (Claude Haiku 5.5) and the plain-words house-rule compiler (three models that must agree).
- `ELEVENLABS_API_KEY`: the device's voice. Without it the browser speaks.

With the Anthropic key set, `npm run dev` uses the live model. `MOCK_MODEL=1 npm run dev` keeps the scripted one.

## Check it

```bash
npm test           # Vitest across all workspaces
npm run lint       # Biome
npm run e2e        # Playwright: the Echo Show end to end, on ports 3100 and 3101
npm run bench      # ShadowBench report in bench/reports/ (no model calls)
npm run inspect    # MCP Inspector; point it at http://localhost:3000/mcp
```

`npm run e2e` uses your installed Chrome. To use Playwright's own Chromium instead, run `npx playwright install chromium` once and set `PLAYWRIGHT_CHROMIUM=1`.

## Use it from another MCP client

With `npm run dev` running, any MCP client can call the server. For Claude Code:

```bash
claude mcp add --transport http shadow-home http://localhost:3000/mcp
```

## Deploy

[deploy.md](deploy.md) puts the server and the Echo Show on Google Cloud Run (`npm run deploy`), and covers the AWS stack, which is built and tested on DynamoDB Local but not deployed.

## Working on it with Claude Code

| Path | Contents |
| --- | --- |
| `CLAUDE.md`, `packages/engine/CLAUDE.md`, `packages/host/CLAUDE.md` | Project rules Claude Code loads automatically |
| `.claude/settings.json` | Allowed commands; blocks reading `.env` and editing `bench/labels/`; the two hooks |
| `.claude/hooks/` | After each edit: Biome and a type-check of the package. On stop: tests for changed packages (one retry, then it lets go). They are bash scripts; on Windows, run Claude Code inside WSL |
| `.claude/agents/` | `verifier`, `red-team`, `spec-checker` |
| `.claude/skills/` | `/day`, `/friction`, `/bench`, `/feedback` |
