// Bundles the MCP server into dist/<target>: server/index.mjs (the entry, with the demo home
// inlined) and dist/plan-view.html, where the views package looks for its built view, one level
// up from the code. Builds the view first if it isn't built.
//   node scripts/bundle.ts             the Lambda handler, in dist/lambda
//   node scripts/bundle.ts cloud-run   the Cloud Run server, in dist/cloud-run
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const entries = { lambda: 'lambda.ts', 'cloud-run': 'cloud-run.ts' };
const target = process.argv[2] ?? 'lambda';
if (!Object.hasOwn(entries, target)) {
  throw new Error(`Bundle which? ${Object.keys(entries).join(' or ')}`);
}
const root = join(import.meta.dirname, '../../..');
const out = join(import.meta.dirname, '../dist', target);
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
  entryPoints: [join(root, 'packages/server/src', entries[target as keyof typeof entries])],
  outfile: join(out, 'server/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  // Some dependencies are CommonJS and call require(); give the ES module one. Firestore's gRPC
  // stack also names __dirname when it loads, though it reads no files from it (its protos are
  // bundled as JSON).
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      ...(target === 'cloud-run'
        ? ['const __dirname = import.meta.dirname; const __filename = import.meta.filename;']
        : []),
    ].join(' '),
  },
  logLevel: 'warning',
});
mkdirSync(join(out, 'dist'), { recursive: true });
copyFileSync(view, join(out, 'dist/plan-view.html'));

const kb = (file: string) => `${Math.round(statSync(file).size / 1024)} KB`;
console.log(`${target}: dist/${target}/server/index.mjs (${kb(join(out, 'server/index.mjs'))})`);
