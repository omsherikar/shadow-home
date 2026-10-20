// Deploys Shadow Home to Google Cloud: the MCP server and the Echo Show host on Cloud Run, the
// home's state in Firestore, the keys in Secret Manager. Safe to run again: each run builds both
// containers from this checkout and rolls both services forward. See docs/deploy.md.
//
//   gcloud auth login && gcloud config set project <id>
//   npm run deploy
//
// Environment (npm run deploy loads .env, then .env.local):
//   ANTHROPIC_API_KEY, ELEVENLABS_API_KEY   stored as secrets on the first run (the voice is
//                                           optional); --update-keys stores them again
//   GCP_REGION      default us-central1
//   MIN_INSTANCES   the server's warm instances (default 0; 1 keeps it fast while judging)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');
const updateKeys = process.argv.includes('--update-keys');

/** A gcloud command's output. Its progress and errors go to the terminal. */
function gcloud(args: string[], input?: string): string {
  return execFileSync('gcloud', [...args, '--quiet'], {
    cwd: root,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
  }).trim();
}

/** A gcloud command whose output the person watches (builds, deploys). */
function watch(args: string[]): void {
  execFileSync('gcloud', [...args, '--quiet'], { cwd: root, stdio: 'inherit' });
}

/** Whether a describe-style command finds the thing, without printing its "not found". */
function found(args: string[]): boolean {
  try {
    execFileSync('gcloud', [...args, '--quiet'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function step(what: string): void {
  console.log(`\n== ${what}`);
}

if (!found(['--version'])) {
  console.error('No gcloud. Install it: brew install --cask google-cloud-sdk');
  process.exit(1);
}
const project = process.env.GOOGLE_CLOUD_PROJECT || gcloud(['config', 'get-value', 'project']);
if (!project) {
  console.error('No project. Run: gcloud config set project <id>');
  process.exit(1);
}
const region = process.env.GCP_REGION ?? 'us-central1';
const p = `--project=${project}`;
const at = `--region=${region}`;
const SERVER = 'shadow-home-mcp';
const HOST = 'shadow-home-host';
const RUNNER = `shadow-home-run@${project}.iam.gserviceaccount.com`;
const registry = `${region}-docker.pkg.dev/${project}/shadow-home`;
const SECRET = {
  plan: 'shadow-home-plan-key',
  anthropic: 'shadow-home-anthropic-key',
  elevenlabs: 'shadow-home-elevenlabs-key',
};

step(`Project ${project}, region ${region}`);
watch([
  'services',
  'enable',
  'run.googleapis.com',
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  'firestore.googleapis.com',
  'secretmanager.googleapis.com',
  'iam.googleapis.com',
  p,
]);

step('Container registry');
if (!found(['artifacts', 'repositories', 'describe', 'shadow-home', `--location=${region}`, p])) {
  watch([
    'artifacts',
    'repositories',
    'create',
    'shadow-home',
    '--repository-format=docker',
    `--location=${region}`,
    p,
  ]);
}

step('Firestore');
if (!found(['firestore', 'databases', 'describe', '--database=(default)', p])) {
  watch([
    'firestore',
    'databases',
    'create',
    '--database=(default)',
    `--location=${region}`,
    '--type=firestore-native',
    p,
  ]);
}
// Each day's home expires on its own (decision 72): the home, its stored results, its log.
for (const group of ['homes', 'items', 'log']) {
  watch([
    'firestore',
    'fields',
    'ttls',
    'update',
    'expiresAt',
    `--collection-group=${group}`,
    '--enable-ttl',
    '--async',
    p,
  ]);
}

step('The identity both services run as');
if (!found(['iam', 'service-accounts', 'describe', RUNNER, p])) {
  watch([
    'iam',
    'service-accounts',
    'create',
    'shadow-home-run',
    '--display-name=Shadow Home on Cloud Run',
    p,
  ]);
}
gcloud([
  'projects',
  'add-iam-policy-binding',
  project,
  `--member=serviceAccount:${RUNNER}`,
  '--role=roles/datastore.user',
  '--condition=None',
  '--format=none',
]);

step('Keys');
/**
 * Makes sure a secret exists, created from `value`; with `replace`, it holds `value` again. False
 * when it doesn't exist and there's nothing to create it from.
 */
function secret(name: string, value: string | undefined, what: string, replace: boolean): boolean {
  const exists = found(['secrets', 'describe', name, p]);
  if (!exists && !value) {
    console.log(`  ${name}: skipped, ${what} is not set`);
    return false;
  }
  if (!exists) {
    gcloud(
      ['secrets', 'create', name, '--replication-policy=automatic', '--data-file=-', p],
      value,
    );
    console.log(`  ${name}: stored`);
  } else if (replace && value) {
    gcloud(['secrets', 'versions', 'add', name, '--data-file=-', p], value);
    console.log(`  ${name}: updated`);
  } else console.log(`  ${name}: kept`);
  gcloud([
    'secrets',
    'add-iam-policy-binding',
    name,
    `--member=serviceAccount:${RUNNER}`,
    '--role=roles/secretmanager.secretAccessor',
    '--format=none',
    p,
  ]);
  return true;
}
// The plan-ID key is made once and kept: a new one would void every plan ID in flight.
secret(SECRET.plan, randomBytes(32).toString('base64url'), 'a plan-ID key', false);
const model = secret(
  SECRET.anthropic,
  process.env.ANTHROPIC_API_KEY,
  'ANTHROPIC_API_KEY',
  updateKeys,
);
const voice = secret(
  SECRET.elevenlabs,
  process.env.ELEVENLABS_API_KEY,
  'ELEVENLABS_API_KEY',
  updateKeys,
);

step('Building both containers in Cloud Build (a few minutes)');
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
});
const tag = `${commit.trim()}-${Date.now().toString(36)}`;
const serverImage = `${registry}/server:${tag}`;
const hostImage = `${registry}/host:${tag}`;
watch([
  'builds',
  'submit',
  '--config=scripts/gcp/cloudbuild.yaml',
  `--substitutions=_SERVER_IMAGE=${serverImage},_HOST_IMAGE=${hostImage}`,
  p,
  '.',
]);

/**
 * Both services: public (Alexa+ and judges call them directly), one vCPU, a few instances at most.
 * A request may take `timeout`, just above the service's longest legitimate one, instead of Cloud
 * Run's 300 s.
 */
const service = (name: string, image: string, timeout: string) => [
  'run',
  'deploy',
  name,
  `--image=${image}`,
  at,
  p,
  `--service-account=${RUNNER}`,
  '--allow-unauthenticated',
  '--cpu=1',
  '--memory=1Gi',
  '--cpu-boost',
  `--timeout=${timeout}`,
];

step('The MCP server');
watch([
  // The longest request is a rule compile, which gives up at 40 s.
  ...service(SERVER, serverImage, '60s'),
  `--min-instances=${process.env.MIN_INSTANCES ?? 0}`,
  '--max-instances=4',
  // Calls to the home take turns, so each request at once on an instance waits for those ahead of
  // it. Two at once kept p99 under about 400 ms in scripts/load.ts; past that, another instance
  // takes the request (docs/decisions.md, 101).
  '--concurrency=2',
  // The project, so log lines carry their request's trace.
  `--set-env-vars=RULE_COMPILER=${model ? 'anthropic' : 'off'},GOOGLE_CLOUD_PROJECT=${project}`,
  `--set-secrets=SHADOW_HOME_SECRET=${SECRET.plan}:latest${
    model ? `,ANTHROPIC_API_KEY=${SECRET.anthropic}:latest` : ''
  }`,
]);
const serverUrl = gcloud([
  'run',
  'services',
  'describe',
  SERVER,
  at,
  p,
  '--format=value(status.url)',
]);

step('The Echo Show host');
const hostSecrets = [
  ...(model ? [`ANTHROPIC_API_KEY=${SECRET.anthropic}:latest`] : []),
  ...(voice ? [`ELEVENLABS_API_KEY=${SECRET.elevenlabs}:latest`] : []),
];
watch([
  // The longest request is a turn: 30 s to set up and decide, then a rule that may take 45 s.
  ...service(HOST, hostImage, '90s'),
  '--min-instances=0',
  '--max-instances=2',
  // Without a model key the host still runs, on the scripted model.
  `--set-env-vars=MCP_SERVER_URL=${serverUrl}/mcp,GOOGLE_CLOUD_PROJECT=${project}${model ? '' : ',MOCK_MODEL=1'}`,
  ...(hostSecrets.length > 0 ? [`--set-secrets=${hostSecrets.join(',')}`] : []),
]);
const hostUrl = gcloud(['run', 'services', 'describe', HOST, at, p, '--format=value(status.url)']);

// The new server against the MCP contract an Alexa+ add-on relies on. It previews and commits
// small plans on the deployed home, which starts over every day.
step('Checking the deployed server');
try {
  execFileSync(process.execPath, ['scripts/check-mcp.ts', `${serverUrl}/mcp`], {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  const back = (name: string) => `  gcloud run revisions list --service=${name} ${at} ${p}
  gcloud run services update-traffic ${name} --to-revisions=REVISION=100 ${at} ${p}`;
  console.error(`
The deployed server failed the check. To send traffic back to an earlier REVISION:
${back(SERVER)}
${back(HOST)}
Later deploys keep that split; --to-latest instead of --to-revisions undoes it.`);
  process.exit(1);
}

console.log(`
MCP server  ${serverUrl}/mcp
Echo Show   ${hostUrl}

Check it:   node scripts/latency.ts ${serverUrl}/mcp 50`);
