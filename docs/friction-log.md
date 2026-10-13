# Friction log

Every snag, written down when it happens. Add entries with `/friction <what happened>`.
Severity: **critical** (blocked), **major** (cost over an hour or forced a redesign), **minor** (annoying).

The first five entries come from the research on Oct 13, before any code. Check the wording before you submit.

---

## 2026-10-13 · Alexa+ add-on tools aren't available to hackathon entrants

- **Tool:** Alexa+ MCP Toolkit, `alexa-ai` CLI, Alexa+ Web Simulator (developer.amazon.com/docs/alexaplus, read Oct 13)
- **Task:** Deploy our MCP server as an Alexa+ add-on and test it in the web simulator
- **Steps:**
  1. Read the MCP Toolkit overview and quickstart.
  2. Looked for how to get the `alexa-ai` CLI.
  3. Read the hackathon FAQ.
- **Expected:** Hackathon entrants can run `alexa-ai deploy` and test in the web simulator.
- **Actual:** The FAQ says the Category SDK, MCP Toolkit, CLI and Web Simulator are limited to select partners, and entrants can't apply.
- **Severity:** major
- **Workaround:** Self-hosted MCP server, plus our own simulated Alexa front end (Next.js + Bedrock) acting as the MCP client.
- **Suggestion:** Give hackathon entrants a sandboxed web simulator, or a recorded-traffic test harness that replays Alexa+ client requests against a developer's server.

## 2026-10-13 · The Alexa+ client's elicitation support is unclear

- **Tool:** Alexa+ MCP client lifecycle docs (mcp-toolkit-client-lifecycle.html, read Oct 13)
- **Task:** Decide how Shadow Home asks the user to confirm a risky plan
- **Steps:**
  1. Read the `initialize` example.
  2. Read the section on elicitation.
- **Expected:** The client's declared capabilities say whether elicitation is supported.
- **Actual:** The example `initialize` sends `protocolVersion "2025-03-26"` and declares only `roots`. The same page says Alexa+ uses "the existing elicitation framework through the MCP protocol."
- **Severity:** major (we redesigned confirmation as two tool calls: `preview_plan`, then `commit_plan` with a signed plan ID)
- **Workaround:** No dependence on elicitation. Use MRTR only when a client declares elicitation.
- **Suggestion:** Declare `elicitation` in the client's capabilities if it's supported, and say whether MRTR (spec 2026-07-28) is planned.

## 2026-10-13 · Three different MCP protocol versions in play

- **Tool:** Hackathon rules, Alexa+ client docs, MCP spec
- **Task:** Pick the MCP spec version to target
- **Steps:** Compared the hackathon requirement, the Alexa+ client example and the current spec.
- **Expected:** One version to target.
- **Actual:** The hackathon asks for 2025-11-25 or later. The Alexa+ client example sends 2025-03-26. The current spec is 2026-07-28 (stateless, MRTR).
- **Severity:** minor
- **Workaround:** MCP TypeScript SDK v2 `createMcpHandler` serves 2026-07-28 and all 2025-era versions by default.
- **Suggestion:** State which protocol versions the Alexa+ client negotiates today, and the timeline for 2026-07-28.

## 2026-10-13 · Amplify Hosting docs list Next.js support only up to 15

- **Tool:** AWS Amplify Hosting (SSR support page, read Oct 13)
- **Task:** Choose a Next.js version for the simulated Alexa app
- **Steps:** Checked the latest Next.js on npm (16.4.0), then Amplify's SSR support page.
- **Expected:** Support for the current Next.js major version.
- **Actual:** The page lists Next.js 12 through 15. It also lists Edge middleware, Edge API routes and streaming as unsupported.
- **Severity:** minor
- **Workaround:** Pinned Next.js 15.5, the Node runtime and non-streamed responses. OpenNext on CDK is the fallback if we need 16.
- **Suggestion:** Update the SSR support page with Next.js 16 status and a date.

## 2026-10-13 · AWS credit status conflicts between pages

- **Tool:** Hackathon Resources page and FAQ
- **Task:** Request AWS promotional credits
- **Steps:** Read the FAQ's credit section, then the Resources page.
- **Expected:** One current answer.
- **Actual:** The FAQ describes a $150-per-person credit request. The Resources page says credit codes ran out on Oct 7.
- **Severity:** minor
- **Workaround:** Free tier only, a $20 budget alarm, and tearing down after judging.
- **Suggestion:** Update the FAQ when credits run out.

---

<!-- New entries below. Template:

## YYYY-MM-DD HH:MM IST · <one-line summary>

- **Tool:** name and exact version
- **Task:**
- **Steps:**
  1.
- **Expected:**
- **Actual:**
- **Severity:** critical | major | minor
- **Workaround:**
- **Suggestion:**
-->
