import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, type Plugin } from 'esbuild';

/**
 * Bundles each MCP App view into one self-contained HTML file in dist/: the script and styles
 * inline, nothing fetched, so it runs under a host's strictest content policy.
 */
const root = join(import.meta.dirname, '..');
const VIEWS = [{ file: 'plan-view.html', entry: 'src/plan-view/main.tsx', title: 'Plan check' }];

/**
 * zod re-exports all 60-odd of its error-message languages as `z.locales`. Nothing in a view
 * reads them (English is set up separately), so keep English only: about 250 KB less per view.
 */
const englishOnly: Plugin = {
  name: 'zod-english-only',
  setup(b) {
    b.onResolve({ filter: /\/locales\/index\.js$/ }, (args) =>
      args.importer.includes(`${join('node_modules', 'zod')}`)
        ? { path: 'zod-locales', namespace: 'english-only' }
        : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: 'english-only' }, () => ({
      contents: "export { default as en } from 'zod/v4/locales/en.js';",
      resolveDir: root,
    }));
  },
};

mkdirSync(join(root, 'dist'), { recursive: true });
for (const view of VIEWS) {
  const out = await build({
    entryPoints: [join(root, view.entry)],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    write: false,
    outdir: join(root, 'dist/.build'),
    logLevel: 'warning',
    plugins: [englishOnly],
  });
  const text = (ext: string) => out.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? '';
  // Inside an inline <script>, "</script" would end the element early.
  const js = text('.js').replaceAll('</script', '<\\/script');
  const css = text('.css').replaceAll('</style', '<\\/style');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${view.title}</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;
  writeFileSync(join(root, 'dist', view.file), html);
  console.log(`views: dist/${view.file} (${Math.round(html.length / 1024)} KB)`);
}
