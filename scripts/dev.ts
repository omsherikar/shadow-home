import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Everything, locally: the MCP server on :3000 and the simulated Echo Show on :3001, with the
 * views built first because the server serves them. Ctrl-C stops both.
 */
const root = join(import.meta.dirname, '..');
execFileSync(process.execPath, [join(root, 'packages/views/scripts/build.ts')], {
  stdio: 'inherit',
});

const parts = [
  { name: 'server', workspace: '@shadow-home/server' },
  { name: 'host  ', workspace: '@shadow-home/host' },
];

const children = parts.map(({ name, workspace }) => {
  const child = spawn('npm', ['run', 'dev', '-w', workspace], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
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
