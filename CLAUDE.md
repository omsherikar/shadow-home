# Shadow Home

An MCP server that checks a voice assistant's smart-home plans before they run:
diff → simulate on a digital twin → house rules → SAFE / UNSAFE / UNPROVEN.
Built for the Amazon Developer Hackathon, Alexa+ track. Deadline: Oct 23, 2026, 12:00 PM PDT.

Full plan: docs/plan.md. Read only the section you need for today's task, not the whole file.
Calls already made (and open questions): docs/decisions.md. Read it before changing engine behaviour.
Demo home: fixtures/demo-home.json (see fixtures/README.md).

## Non-negotiables

- packages/engine is pure TypeScript: no I/O, no network, no LLM SDK imports,
  no Date.now() or Math.random(). Time, forecast and seeds are passed in.
- Same input, same verdict. Every engine change ships with a test.
- Never edit bench/labels/. If a label looks wrong, stop and tell me why.
- Never weaken a test, a rule or a threshold to make something pass. Explain the failure instead.
- No LLM anywhere in the check path. Models only draft plans, compile rules and talk.
- MCP tool results: structuredContent must match the declared outputSchema; p99 round trip < 500 ms.
- Speech fields: headline <= 15 words; reason and ask <= 25 words each.
- Device brands in fixtures and the demo are fictional. No real trademarks.

## Commands

- npm run dev       start everything locally: MCP server :3000, Echo Show host :3001 (in-memory store; the live model on the Anthropic API when ANTHROPIC_API_KEY is in .env or .env.local, else the scripted model; MOCK_MODEL=1 forces it)
- npm run demo      the same, plus "Play the demo": the demo script start to finish, no model calls
- npm run record-demo  record a live model run of each demo request into fixtures/demo-script.json (needs npm run dev)
- npm test          Vitest across all workspaces
- npm run e2e       Playwright: the Echo Show screen end to end, on its own ports (3100, 3101); CI runs it on Playwright's Chromium (PLAYWRIGHT_CHROMIUM=1)
- npm run deploy    build both containers in Cloud Build and deploy the server and host to Cloud Run (docs/deploy.md)
- npm run synth     bundle the server for Lambda and synthesize the CDK stack (no AWS account needed); deploy:aws deploys it
- Store tests run against local stand-ins when set: DYNAMODB_ENDPOINT (DynamoDB Local), FIRESTORE_EMULATOR_HOST (CI does both)
- npm run lint      Biome check
- npm run bench     ShadowBench report to bench/reports/ (no model calls); -- --judge adds the LLM judge (one call per plan, cached); -- --stress the twin mismatch; -- --gate is CI's check
- npm run inspect   MCP Inspector (point it at http://localhost:3000/mcp)

## Map

- packages/twin     home model types (Matter clusters + Alexa interface names), fixture loader
- packages/engine   lint → hygiene → simulate (3 runs) → rules → verdict + repairs + tier
- packages/rules    the house-rule compiler: three Strands agents (Anthropic API, or Bedrock) that must agree
- packages/server   MCP server: 7 tools, MCP App resources, plan signing, in-memory, Firestore and DynamoDB stores, Cloud Run and Lambda entries
- packages/views    MCP App views (diff + timeline), one HTML file each, built with esbuild
- packages/host     simulated Alexa: Next.js 15.5 app; route handlers run the model loop (Anthropic API) and the voice (ElevenLabs)
- packages/infra    the server bundle (Cloud Run and Lambda) and the AWS CDK stack (Lambda + Function URL, DynamoDB, Secrets Manager)
- scripts/gcp       the Google Cloud deploy: Cloud Build config and deploy.ts (Cloud Run, Firestore, Secret Manager)
- bench/            ShadowBench: plans, labels (read-only for Claude), runner, reports
- docs/             plan.md, friction-log.md

## Protocol notes

- Server: @modelcontextprotocol/server v2 with createMcpHandler (legacy: 'stateless').
  It serves spec 2026-07-28 and 2025-era clients (2025-11-25; Alexa+ sends 2025-03-26).
- Don't rely on elicitation: the Alexa+ client declares only `roots`. Confirm with
  preview_plan → commit_plan and a signed plan ID.
- Annotations: preview_plan, undo, get_home_state, get_activity_log are read-only and
  closed-world; commit_plan is destructive and idempotent by plan ID; approve_plan is visible to the app only.

## Style

- TypeScript strict. zod for every external input. Biome for formatting and lint.
- Units: Celsius, watts, minutes internally. Convert only at the edges.
- Small commits; the message says what changed and why.
- When a task is done, log anything that fought you with /friction.
