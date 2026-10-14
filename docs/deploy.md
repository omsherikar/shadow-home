# Deploying Shadow Home

Everything runs locally without AWS (`npm run dev`). This page puts the MCP server on AWS Lambda
with a public URL, and the Echo Show host on Amplify Hosting. Region: us-east-1.

## What gets created

`packages/infra` is one CDK stack, `ShadowHome`:

- **MCP server:** one Lambda (Node 22, arm64) behind a public Function URL. Its state is in a
  DynamoDB table and its plan-ID key in Secrets Manager. House rules in plain words are compiled
  with Bedrock (three Claude models that must agree).
- **Host role:** an IAM role that lets the host on Amplify call Bedrock and Polly.
- **Outputs:**
  - `McpUrl`, the MCP endpoint for Alexa+, MCP Inspector and the host.
  - `HostComputeRoleArn`, the role to give the host on Amplify.

The deployed home starts over from `fixtures/demo-home.json` every day at 08:00 UTC
(`docs/decisions.md`, 72).

## Before the first deploy

1. The AWS account must be fully registered. Until then Lambda, DynamoDB and CloudFormation
   answer "needs a subscription for the service".
2. In the Bedrock console (us-east-1), make sure Claude Sonnet 4.6, Haiku 4.5 and Opus 4.6 can be
   called; `npm run bedrock:ping` checks one.
3. Sign in, then bootstrap CDK once per account and region:
   - `aws login --profile shadow-home`
   - `export AWS_PROFILE=shadow-home`
   - `npm run bootstrap -w @shadow-home/infra`

## Deploy the server

- `npm run deploy` bundles the server, synthesizes the stack and deploys it.
- `npm run synth` does the same without deploying; it needs no AWS account.

## Check the server

Use the `McpUrl` output (it ends in `/mcp`):

- `node scripts/latency.ts <McpUrl> 50` reports the round trip of `preview_plan`, p50 and p99.
- `npm run inspect`, then point the Inspector at the URL.
- The spec-checker agent runs the whole checklist against a URL you give it.

Before deploying, the same checks can run on a laptop against the deployed bundle:

- `docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local` (in a second terminal)
- `npm run bundle -w @shadow-home/infra`
- `npm run serve-lambda -w @shadow-home/infra` serves it at http://localhost:3200/mcp

## Deploy the host on Amplify Hosting

In the Amplify console:

1. Create an app from this GitHub repository's `main` branch. It's a monorepo: set the app root
   to `packages/host`. Amplify reads `amplify.yml` at the repository root.
2. Add these environment variables:
   - `AMPLIFY_MONOREPO_APP_ROOT=packages/host`
   - `MCP_SERVER_URL=<McpUrl>`
   - Optionally `BEDROCK_MODEL_ID` and `POLLY_VOICE`.
3. Under the app's settings, set the compute role to `HostComputeRoleArn`.
4. Deploy. The host talks to Bedrock (its own model loop) and Polly through that role.

Don't set `DEMO_MODE` or `DEMO_CLOCK` on Amplify: they need the local server's demo controls.
Record the demo locally with `npm run demo`.

## Remove it

`npm run destroy -w @shadow-home/infra` removes the stack. The table, secret and
logs go with it. Delete the Amplify app in its console.
