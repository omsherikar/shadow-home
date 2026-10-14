# packages/host

The simulated Alexa+ experience: a Next.js 15.5 (App Router) app with React 19.

## Rules for this package

- Stay on Next.js 15.5: Amplify Hosting documents SSR support only for Next.js 12–15.
- Route handlers use the Node runtime (`export const runtime = 'nodejs'`). No Edge runtime,
  no streamed responses (Amplify doesn't support them).
- app/api/turn/route.ts: one conversational turn. Bedrock Converse loop (Claude Haiku-class model)
  with the MCP client from @modelcontextprotocol/client, pointed at MCP_SERVER_URL.
- app/api/speak/route.ts: Amazon Polly text → audio.
- app/mcp/route.ts: the browser's same-origin way to the MCP server (views call tools through it).
  Forward MCP protocol headers only; read responses whole.
- Non-route code lives in src/: turn/ (the model loop and the scripted model), screen/ (the
  sandboxed view frame and AppBridge), device/ (the Echo Show page).
- Render MCP App views in a sandboxed iframe through @modelcontextprotocol/ext-apps/app-bridge.
  If a tool result has no `_meta.ui.resourceUri`, draw its structuredContent yourself.
- Every on-screen control has a spoken equivalent ("undo", "yes", "just the lights").
- Demo mode (DEMO_MODE=1) replays fixtures/demo-script.json with recorded plans, no model calls.
- MOCK_MODEL=1 swaps Bedrock for a scripted model so the app runs with no AWS credentials.
- DEMO_CLOCK=1: before a turn, move home time to the scene of the demo line heard (server needs
  SHADOW_HOME_DEMO=1). SHADOW_HOME_SILENT=1: don't speak (browser tests).
- AWS: AWS_PROFILE (default shadow-home), AWS_REGION (default us-east-1), BEDROCK_MODEL_ID,
  POLLY_VOICE. Load the AWS SDK only where it's used, so the scripted model starts fast.
- What the device says comes from the server's speech fields when a tool returned them.
- The screen is read from across a room: at most 5 diff rows, large type, verdict as icon + word + color.
