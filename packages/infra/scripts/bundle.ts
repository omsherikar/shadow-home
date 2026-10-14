// Bundles the MCP server for Lambda into dist/lambda: server/index.mjs (the handler, with the
// demo home inlined) and dist/plan-view.html, where the views package looks for its built view,
// one level up from the code. Builds the view first if it isn't built.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '../../..');
const out = join(import.meta.dirname, '../dist/lambda');
const view = join(root, 'packages/views/dist/plan-view.html');

if (!existsSync(view)) {
  const { execFileSync } = await import('node:child_process');
  execFileSync('npm', ['run', 'build', '-w', '@shadow-home/views'], {
    cwd: root,
    stdio: 'inherit',
  });
}

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [join(root, 'packages/server/src/lambda.ts')],
  outfile: join(out, 'server/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  // Some dependencies are CommonJS and call require(); give the ES module one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
mkdirSync(join(out, 'dist'), { recursive: true });
copyFileSync(view, join(out, 'dist/plan-view.html'));

const kb = (file: string) => `${Math.round(statSync(file).size / 1024)} KB`;
console.log(`lambda: dist/lambda/server/index.mjs (${kb(join(out, 'server/index.mjs'))})`);
