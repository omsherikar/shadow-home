# Deploying Shadow Home

Everything runs locally without any cloud account (`npm run dev`). This page puts the MCP server
and the Echo Show host on Google Cloud Run. The AWS stack (Lambda, DynamoDB, Amplify) is still
here and works the same way once an account can run it; it's at the end.

## Keys

The live model, the house-rule compiler and the device's voice need two keys:

- `ANTHROPIC_API_KEY`: the voice loop (Claude Haiku 5.5) and the rule compiler (Sonnet 5.5,
  Haiku 5.5 and Opus 5.5, which must agree).
- `ELEVENLABS_API_KEY`: the device's voice. Optional; without it the browser speaks.

Put them in `.env` or `.env.local` at the repo root (both git-ignored), one `NAME=value` per line.
`npm run dev`, `npm run demo`, `npm run record-demo` and `npm run deploy` load both (`.env.local`
wins; the shell's own variables win over either). With the Anthropic key there,
`npm run dev` uses the live model (`MOCK_MODEL=1` keeps the scripted one).

Optional overrides: `ANTHROPIC_MODEL_ID` (the voice loop's model), `RULE_COMPILER_MODELS` (three
model IDs, comma-separated), `ELEVENLABS_VOICE_ID`.

Both services are public, so anyone with the URLs spends from these keys. Each instance caps
what it spends in any rolling hour, and the host also caps each visitor (the client's address), so
one script can't use the hour up for everyone:

- `LIVE_TURNS_PER_HOUR` (host, default 60) and `LIVE_TURNS_PER_VISITOR_HOUR` (default 20):
  live-model turns; past either the device says to try later. Scripted and demo turns don't count.
- `SPEECH_CHARS_PER_HOUR` (host, default 30,000) and `SPEECH_CHARS_PER_VISITOR_HOUR` (default
  5,000): characters of ElevenLabs speech, which is how it bills. Past a visitor's budget the
  browser speaks that line; past the instance's, it speaks for the rest of the session.
- `RULE_COMPILES_PER_HOUR` (server, default 10): plain-words rules, three model calls each; past
  it the rule isn't compiled ("I couldn't work out that rule just now").

With at most 2 host and 4 server instances, that bounds the worst hour. Change one with
`gcloud run services update shadow-home-host --region=us-central1 --update-env-vars=LIVE_TURNS_PER_HOUR=30`.
A visitor is the address Google's front end adds at the right of `X-Forwarded-For`. Behind a
Google HTTPS load balancer, which appends its own address after the client's, set
`CLIENT_IP_HOPS=1` on the host.
Also set a monthly spend limit in the Anthropic console, and keep an eye on ElevenLabs' quota.

## Google Cloud

### What gets created

`npm run deploy` (scripts/gcp/deploy.ts) sets up, in one project and region (default
`us-central1`):

- **MCP server:** Cloud Run service `shadow-home-mcp`, public, 1 vCPU, at most 4 instances, each
  taking at most 2 requests at once, so 8 in all (`docs/decisions.md`, 101). Past that, Cloud Run
  holds a request for an instance to free or start, for 10 seconds or 3.5 times an instance's
  start-up time, whichever is longer, then answers 429; if judging traffic ever reaches it, raise
  `--max-instances` in scripts/gcp/deploy.ts (which also raises the worst hour of rule compiles
  above). Its state is in Firestore (the `homes` collection) and its plan-ID key in Secret Manager.
- **Echo Show host:** Cloud Run service `shadow-home-host`, public, at most 2 instances, pointed at
  the server's `/mcp`.
- **Secrets:** `shadow-home-plan-key` (made once and kept), `shadow-home-anthropic-key`,
  `shadow-home-elevenlabs-key`.
- **Identity:** the service account `shadow-home-run`, which can use Firestore and read those three
  secrets, and nothing else.
- **Images:** built by Cloud Build (scripts/gcp/cloudbuild.yaml) into the Artifact Registry
  repository `shadow-home`.

The deployed home starts over from `fixtures/demo-home.json` every day at 08:00 UTC
(`docs/decisions.md`, 72). Old days expire through Firestore TTL on `expiresAt`.

### Before the first deploy

1. A Google Cloud project with billing turned on (Cloud Run and Cloud Build need it, even within
   the free tier).
2. The Google Cloud CLI, signed in:
   - `brew install --cask google-cloud-sdk`
   - `gcloud auth login`
   - `gcloud config set project <project-id>`
3. The keys in `.env` or `.env.local` (above). The first deploy stores them as secrets.

### Deploy

- `npm run deploy` turns on the services it needs, creates what's missing, builds both containers
  and deploys both services. It prints the MCP URL and the host's URL. The first run takes a few
  minutes; later runs only build and roll forward.
- `npm run deploy -- --update-keys` stores the keys from the env files again (the plan-ID key is
  never replaced: a new one would void plan IDs in flight).
- `GCP_REGION` picks another region. `MIN_INSTANCES=1` keeps one server instance warm, which costs
  a little while idle; use it while recording and judging.
- At the end it runs `scripts/check-mcp.ts` against the new server. If that fails, it prints the
  commands below for both services and exits with an error.
- A request may take 60 s on the server (a rule compile gives up at 40 s) and 90 s on the host (a
  turn sets up and decides within 30 s, then a rule may still take 45 s), not Cloud Run's 300 s.

### Check the server

Use the MCP URL it printed (it ends in `/mcp`):

- `node scripts/check-mcp.ts <mcp-url>` runs the contract checklist: Alexa+'s 2025-03-26
  handshake, both protocol eras, the seven tools with their annotations and schemas, the plan
  view resource, and commit_plan's refusals (a tampered ID, an UNSAFE plan, a stale preview). It
  commits two small plans, so the home it checks changes.
- `node scripts/latency.ts <mcp-url> 50` reports the round trip of `preview_plan`, p50 and p99.
  From far away most of that is the network; Cloud Run's request logs give the server's own time:
  `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="shadow-home-mcp"' --format='value(httpRequest.latency)'`.
- `node scripts/load.ts` measures `preview_plan` with 1 to 32 requests at once (p50, p90, p99),
  which is what the server's 2 at once was set from. Run it against a local server
  (`node packages/server/src/main.ts`), not the deployed one: it sends about 7,000 previews.
- `npm run inspect`, then point the Inspector at the URL.
- The spec-checker agent runs the whole checklist against a URL you give it.

The same container runs on a laptop against the Firestore emulator:

- `docker run --rm -p 127.0.0.1:8080:8080 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators gcloud emulators firestore start --host-port=0.0.0.0:8080`
- `docker build -f packages/server/Dockerfile -t shadow-home-server .`
- `docker run --rm -p 127.0.0.1:3300:8080 -e FIRESTORE_EMULATOR_HOST=host.docker.internal:8080 -e GOOGLE_CLOUD_PROJECT=demo-shadow-home -e METADATA_SERVER_DETECTION=none -e SHADOW_HOME_SECRET=local-only shadow-home-server`
  serves it at http://localhost:3300/mcp

### Custom domain

Cloud Run domain mappings put both services on your own domain, with Google-managed certificates,
without a load balancer's fixed monthly charge (`docs/decisions.md`, 106). Ours: the Echo Show at https://shadowhome.omstudio.tech and
the MCP server at https://mcp.shadowhome.omstudio.tech/mcp. Mappings exist only in some regions,
`us-central1` among them.

1. Verify the domain for the account gcloud uses: `gcloud domains verify <your domain>` opens
   Google Search Console, which asks for a TXT record at the domain's DNS (ours is Vercel DNS).
2. Map a name to each service:
   `gcloud beta run domain-mappings create --service=shadow-home-host --domain=<host name> --region=us-central1`,
   and the same for `shadow-home-mcp` with `<mcp name>` (`gcloud components install beta` first).
   The domain-mapping API takes the same request without the beta component:
   `curl -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" -H 'content-type: application/json' https://us-central1-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/<project>/domainmappings -d '{"apiVersion": "domains.cloudrun.com/v1", "kind": "DomainMapping", "metadata": {"name": "<host name>", "namespace": "<project>"}, "spec": {"routeName": "shadow-home-host"}}'`.
3. At the DNS, a CNAME for each subdomain to `ghs.googlehosted.com`. A root domain can't have a
   CNAME: give it the A and AAAA records Cloud Run lists for its mapping instead
   (`gcloud beta run domain-mappings describe`, below).
4. If the domain has CAA records, they must allow `pki.goog` and `letsencrypt.org`, which issue
   the certificates.
5. Wait for the certificates: ours took about 17 minutes; Google allows up to 24 hours.
   `gcloud beta run domain-mappings describe --domain=<host name> --region=us-central1` shows
   whether a mapping is ready.
6. Check it: `node scripts/check-mcp.ts https://<mcp name>/mcp` (ours passes 15 of 15).

Health checks: Cloud Run's front end keeps some paths ending in z for itself, and `/healthz` is one
of them: it gets Google's own 404 on the run.app URL and on the domain, and never reaches the
server. The server answers `/health` as well; the host answers `GET /api/turn`. Uptime checks on
both, every 5 minutes from every region (what they cost is on Cloud Monitoring's pricing page):

- `gcloud monitoring uptime create shadow-home-mcp --resource-type=uptime-url --resource-labels=host=<mcp name>,project_id=<project> --protocol=https --path=/health --period=5`
- `gcloud monitoring uptime create shadow-home-host --resource-type=uptime-url --resource-labels=host=<host name>,project_id=<project> --protocol=https --path=/api/turn --period=5`

### If a deploy goes wrong

Each deploy is a new revision, and the earlier ones stay. Find the last good one and send all
traffic back to it:

- `gcloud run revisions list --service=shadow-home-mcp --region=us-central1`
- `gcloud run services update-traffic shadow-home-mcp --to-revisions=REVISION=100 --region=us-central1`

and the same for `shadow-home-host`. Later deploys keep that split, so once a fix is deployed,
send traffic to the newest revision again with
`gcloud run services update-traffic shadow-home-mcp --to-latest --region=us-central1`.
On Cloud Run each log line is JSON with a `severity`, so
`gcloud logging read 'resource.labels.service_name="shadow-home-host" AND severity>=WARNING'`
shows what went wrong; lines written while answering a request are filed under it.

### Remove it

In the console, or:

- `gcloud run services delete shadow-home-mcp shadow-home-host --region=us-central1`
- `gcloud secrets delete shadow-home-plan-key` (and the two key secrets)
- `gcloud artifacts repositories delete shadow-home --location=us-central1`

Old homes in Firestore expire on their own; deleting the database is a console action.

## AWS (when an account can run it)

`packages/infra` is one CDK stack, `ShadowHome`, in us-east-1:

- **MCP server:** one Lambda (Node 22, arm64) behind a public Function URL, state in DynamoDB, the
  plan-ID key in Secrets Manager. Set `RULE_COMPILER=anthropic` to compile rules on the Anthropic
  API; the stack sets `bedrock`.
- **Host role:** an IAM role that lets the host on Amplify call Bedrock and Polly.
- **Outputs:** `McpUrl` (the MCP endpoint) and `HostComputeRoleArn`.

Before the first deploy:

1. The AWS account must be fully registered. Until then S3, Lambda, DynamoDB and CloudFormation
   answer "needs a subscription for the service", and Bedrock refuses Claude.
2. In the Bedrock console (us-east-1), make sure Claude Sonnet 4.6, Haiku 4.5 and Opus 4.6 can be
   called; `npm run bedrock:ping` checks one.
3. Sign in, then bootstrap CDK once per account and region:
   - `aws login --profile shadow-home`
   - `npm run bootstrap -w @shadow-home/infra`

   Bootstrap, deploy and destroy use the `shadow-home` profile unless `AWS_PROFILE` names
   another.

Deploy:

- `npm run deploy:aws` bundles the server, synthesizes the stack and deploys it.
- `npm run synth` does the same without deploying; it needs no AWS account.
- Before deploying, the bundle runs on a laptop against DynamoDB Local:
  `docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local`, then
  `npm run bundle -w @shadow-home/infra` and `npm run serve-lambda -w @shadow-home/infra`
  (http://localhost:3200/mcp).

The host on Amplify Hosting:

1. Create an app from this GitHub repository's `main` branch, with the app root `packages/host`.
   Amplify reads `amplify.yml` at the repository root.
2. Environment variables: `AMPLIFY_MONOREPO_APP_ROOT=packages/host`, `MCP_SERVER_URL=<McpUrl>`,
   and `MODEL_PROVIDER=bedrock` with `SPEECH=polly` to use the role (optionally
   `BEDROCK_MODEL_ID`, `POLLY_VOICE`).
3. Under the app's settings, set the compute role to `HostComputeRoleArn`, then deploy.

Don't set `DEMO_MODE` or `DEMO_CLOCK` on a deployed host: they need the local server's demo
controls. Record the demo locally with `npm run demo`.

`npm run destroy -w @shadow-home/infra` removes the stack; delete the Amplify app in its console.
