# packages/host

The simulated Alexa+ experience: a Next.js 15.5 (App Router) app with React 19.

## Rules for this package

- Stay on Next.js 15.5: Amplify Hosting documents SSR support only for Next.js 12–15.
- Route handlers use the Node runtime (`export const runtime = 'nodejs'`). No Edge runtime,
  no streamed responses (Amplify doesn't support them).
- app/api/turn/route.ts: one conversational turn. Bedrock Converse loop (Claude Haiku-class model)
  with the MCP client from @modelcontextprotocol/client, pointed at MCP_SERVER_URL.
- app/api/speak/route.ts: Amazon Polly text → audio.
- Render MCP App views in a sandboxed iframe through @modelcontextprotocol/ext-apps/app-bridge.
  If a tool result has no `_meta.ui.resourceUri`, draw its structuredContent yourself.
- Every on-screen control has a spoken equivalent ("undo", "yes", "just the lights").
- Demo mode (DEMO_MODE=1) replays fixtures/demo-script.json with recorded plans, no model calls.
- MOCK_MODEL=1 swaps Bedrock for a scripted model so the app runs with no AWS credentials.
- The screen is read from across a room: at most 5 diff rows, large type, verdict as icon + word + color.
