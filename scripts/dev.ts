import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Everything, locally: the MCP server on :3000 and the simulated Echo Show on :3001, with the
 * views built first because the server serves them. Ctrl-C stops both.
 *
 * Locally the server has its demo controls on, so demo lines move home time to their scene.
 * The host uses a live model when ANTHROPIC_API_KEY is set, or with MOCK_MODEL=0 (the Anthropic
 * API, or Bedrock with MODEL_PROVIDER=bedrock and the shadow-home AWS profile), and the server
 * compiles house rules in plain words on the same provider. Otherwise, or with MOCK_MODEL=1, the
 * scripted model, which knows only the demo requests. Keys can sit in .env or .env.local at the repo
 * root (`npm run dev` loads both; .env.local wins). `--demo` adds "Play the demo", which replays the demo script start to
 * finish.
 */
const root = join(import.meta.dirname, '..');
const demo = process.argv.includes('--demo');
// Demo mode replays the script and makes no model calls, so it never turns the live model on.
const live =
  !demo &&
  (process.env.MOCK_MODEL === '0' ||
    (process.env.MOCK_MODEL === undefined && Boolean(process.env.ANTHROPIC_API_KEY)));
const provider = process.env.MODEL_PROVIDER === 'bedrock' ? 'bedrock' : 'anthropic';
console.log(
  demo
    ? 'Model: none, demo mode replays the script'
    : live
      ? `Model: live (${provider === 'bedrock' ? 'Bedrock' : 'Anthropic API'}); MOCK_MODEL=1 for the scripted one`
      : 'Model: scripted, demo requests only (set ANTHROPIC_API_KEY in .env for the live model)',
);
execFileSync(process.execPath, [join(root, 'packages/views/scripts/build.ts')], {
  stdio: 'inherit',
});

const parts = [
  {
    name: 'server',
    workspace: '@shadow-home/server',
    env: { SHADOW_HOME_DEMO: '1', ...(live ? { RULE_COMPILER: provider } : {}) },
  },
  {
    name: 'host  ',
    workspace: '@shadow-home/host',
    env: {
      DEMO_CLOCK: '1',
      MOCK_MODEL: live ? '0' : '1',
      ...(demo ? { DEMO_MODE: '1' } : {}),
    },
  },
];

const children = parts.map(({ name, workspace, env }) => {
  const child = spawn('npm', ['run', 'dev', '-w', workspace], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (chunk: Buffer) => {
      const lines = (rest + chunk.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) process.stdout.write(`${name} | ${line}\n`);
    });
  }
  child.on('exit', (code) => {
    process.stdout.write(`${name} | exited (${code ?? 'signal'})\n`);
    stop(code ?? 1);
  });
  return child;
});

let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
