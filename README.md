# Shadow Home

**Alexa can suggest. Shadow Home checks.** An MCP server that dry-runs a voice assistant's smart-home plan on a digital twin of the house before anything happens. It returns SAFE, UNSAFE or UNPROVEN, explains why in one breath, suggests a safe fix, and keeps an undo log.

> Status: starter kit (Oct 13, 2026). Built for the Amazon Developer Hackathon, Alexa+ track. Everything here is new during the hackathon.

## Why

- LLM planners are good at making plans and bad at making safe ones. In DESPITE (2026), the best planner made invalid plans 0.4% of the time but dangerous plans 28.3% of the time.
- Home agents fail most on timing. In SimuHome (ICLR 2026), even the best model completed only about 54% of tasks.
- Shadow Home keeps the LLM out of the decision. Models plan and talk; deterministic code simulates the house forward in time and decides.

The research basis and the full build plan are in [docs/plan.md](docs/plan.md).

Building it? Start with [docs/getting-started.md](docs/getting-started.md).

## Run it

```bash
nvm use            # Node 22
npm install
npm run dev        # everything locally: in-memory store, mock model, no AWS needed
npm test
npm run bench      # ShadowBench report in bench/reports/
```

## Layout

| Path | What it is |
| --- | --- |
| `packages/twin` | Home model: Matter-shaped devices with Alexa interface names |
| `packages/engine` | Verdict engine: lint, hygiene, three simulations, rules, repairs |
| `packages/rules` | House rules in five templates; plain-language compiler |
| `packages/server` | MCP server (7 tools, Streamable HTTP, MCP Apps view) |
| `packages/views` | MCP App views: diff and timeline |
| `packages/host` | Simulated Alexa: Next.js app, Claude voice loop, ElevenLabs voice |
| `packages/infra` | AWS CDK |
| `bench/` | ShadowBench: hand-labelled plans and the runner |
| `fixtures/` | The fictional demo home and the demo script |

## License

Apache-2.0. See [LICENSE](LICENSE). Copyright 2026 the Shadow Home authors.
