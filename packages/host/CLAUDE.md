# packages/host

The simulated Alexa+ experience: a Next.js 15.5 (App Router) app with React 19.

## Rules for this package

- Stay on Next.js 15.5: Amplify Hosting documents SSR support only for Next.js 12–15.
- Route handlers use the Node runtime (`export const runtime = 'nodejs'`). No Edge runtime.
- /api/turn streams each turn as Server-Sent Events when the client asks (`Accept:
  text/event-stream`), and answers with the whole turn as JSON otherwise (src/turn/respond.ts,
  src/turn/events.ts; decision 107). Cloud Run streams; Amplify Hosting doesn't, so it no longer
  hosts the device.
- app/api/turn/route.ts: one conversational turn. A Converse-shaped model loop (Claude Haiku-class)
  with the MCP client from @modelcontextprotocol/client, pointed at MCP_SERVER_URL. It runs on the
  Anthropic API (src/turn/anthropic.ts translates), or on Bedrock with MODEL_PROVIDER=bedrock.
- app/api/speak/route.ts: text → audio with ElevenLabs (SPEECH=polly for Amazon Polly).
- app/mcp/route.ts: the browser's same-origin way to the MCP server (views call tools through it).
  Forward MCP protocol headers only; read responses whole.
- Non-route code lives in src/: turn/ (the model loop and the scripted model), screen/ (the
  sandboxed view frame and AppBridge), device/ (the Echo Show page), house/ (the 3D house) and
  stage/ (the page around them: split or house-only, the demo controls' drawer).
- The 3D house (three.js through React Three Fiber) loads in the browser only (`next/dynamic`,
  `ssr: false`) and draws get_home_state; it never simulates. Its layout (src/house/layout.ts) is
  made by hand for fixtures/demo-home.json. Assets live in public/house: CC0 from Poly Haven only,
  each listed in CREDITS.md, textures WebP and meshes quantized, never Draco, meshopt or KTX2 (their
  decoders need WebAssembly). Nothing loads from another origin. Without WebGL the page is the
  device alone, as before.
- The house plays each preview forward (src/house/playback.ts, src/stage/HousePanel.tsx) from what
  the tool results carry: the timeline, the broken rules, the `_meta` temperatures and the `_meta`
  replay (who each check took to be home, and the repair's run). It never fills a gap with a guess,
  never reads presence from a call's arguments, and checks all of it with zod: what it can't read,
  it doesn't play. Keep the number of lights fixed (dark when off): changing it rebuilds every
  shader mid-playback. The house never holds up the device: it plays only after the plan view
  reports it drew the result, and where frames are slow (src/house/pace.ts; software WebGL draws
  lean) it shows each run's end instead of sweeping. It acts out the plan's own changes first, then
  runs the clock at its pace (src/house/pacing.ts) under a timeline (src/stage/Timeline.tsx) that
  pauses, speeds up and drags; its styles live in src/stage/house-panel.css.
- Render MCP App views in a sandboxed iframe through @modelcontextprotocol/ext-apps/app-bridge.
  If a tool result has no `_meta.ui.resourceUri`, draw its structuredContent yourself.
- Every on-screen control has a spoken equivalent ("undo", "yes", "just the lights").
- Demo mode (DEMO_MODE=1) replays fixtures/demo-script.json with recorded plans, no model calls.
- MOCK_MODEL=1 swaps the live model for a scripted one so the app runs with no keys.
- DEMO_CLOCK=1: before a turn, move home time to the scene of the demo line heard (server needs
  SHADOW_HOME_DEMO=1). SHADOW_HOME_SILENT=1: don't speak (browser tests).
- Keys: ANTHROPIC_API_KEY (ANTHROPIC_MODEL_ID overrides the model), ELEVENLABS_API_KEY
  (ELEVENLABS_VOICE_ID overrides the voice). AWS, when chosen: AWS_PROFILE (default shadow-home on a
  laptop; in AWS, the role's own credentials), AWS_REGION (default us-east-1), BEDROCK_MODEL_ID,
  POLLY_VOICE. Load each SDK only where it's used, so the scripted model starts fast.
- Deployed on Cloud Run from packages/host/Dockerfile (Next's standalone server; NEXT_OUTPUT=standalone
  only there), keys from Secret Manager. Amplify Hosting is no longer supported, since turns stream
  (amplify.yml and the stack's HostComputeRoleArn remain); behind Amplify's proxy the site's host
  arrives as X-Forwarded-Host.
- What the device says comes from the server's speech fields when a tool returned them.
- The screen is read from across a room: at most 5 diff rows, large type, verdict as icon + word + color.
