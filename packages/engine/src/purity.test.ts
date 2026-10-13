import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

// The engine's non-negotiables (packages/engine/CLAUDE.md), checked on every run. Covers the
// engine's own source and the twin's main entry, which the engine imports.
const FORBIDDEN: [RegExp, string][] = [
  [/(from|import)\s*\(?\s*['"]node:/, 'a node: import'],
  [/(from|import)\s*\(?\s*['"](fs|net|http|https|child_process|os|crypto)['"]/, 'a Node built-in'],
  [/\brequire\s*\(/, 'require()'],
  [/\bimport\s*\(/, 'a dynamic import()'],
  [/\bfetch\s*\(/, 'fetch'],
  [/['"]@aws-sdk\//, 'an AWS SDK import'],
  [/['"](@anthropic-ai|@strands-agents|openai)/, 'an LLM SDK import'],
  [/['"]@shadow-home\/(server|host|rules|views|infra)/, 'an import from a non-engine package'],
  [/['"]@shadow-home\/twin\/node['"]/, 'the twin Node entry (it reads files)'],
  [/\bDate\.now\b/, 'Date.now'],
  [/\bnew\s+Date\s*(\(\s*\))?(?!\s*\()/, 'new Date with no argument'],
  [/(?<![.\w]|new\s)Date\s*\(/, 'Date() called as a function'],
  [/\bperformance\.now\b/, 'performance.now'],
  [/\bMath\.random\b/, 'Math.random'],
  [/\bcrypto\.(randomUUID|getRandomValues)\b/, 'crypto randomness'],
];

const twinSrc = join(import.meta.dirname, '../../twin/src');

function sourcesUnder(dir: string, skip: (rel: string) => boolean): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !skip(f))
    .map((f) => join(dir, f));
}

const sources = [
  ...sourcesUnder(import.meta.dirname, () => false),
  ...sourcesUnder(twinSrc, (rel) => rel === 'node.ts'),
];

test('there is engine and twin source to check', () => {
  expect(sources.some((f) => f.includes('/engine/'))).toBe(true);
  expect(sources.some((f) => f.includes('/twin/'))).toBe(true);
});

test.each(sources.map((f) => [relative(join(import.meta.dirname, '../..'), f), f]))(
  '%s stays pure',
  (_rel, file) => {
    const text = readFileSync(file, 'utf8');
    const hits = FORBIDDEN.filter(([re]) => re.test(text)).map(([, what]) => what);
    expect(hits).toEqual([]);
  },
);

test.each([
  ['const t = Date.now();', 'Date.now'],
  ['const t = new Date();', 'new Date with no argument'],
  ['const t = new Date;', 'new Date with no argument'],
  ['const t = Date();', 'Date() called as a function'],
  ['const t = performance.now();', 'performance.now'],
  ['const r = Math.random();', 'Math.random'],
  ['const id = crypto.randomUUID();', 'crypto randomness'],
  ["import 'node:fs';", 'a node: import'],
  ["const fs = await import('node:fs');", 'a node: import'],
  ["const fs = require('fs');", 'require()'],
])('the guard catches %s', (code, what) => {
  expect(FORBIDDEN.filter(([re]) => re.test(code)).map(([, w]) => w)).toContain(what);
});

test.each([
  'const ms = Date.parse(iso);',
  'const d = new Date(ms + offset);',
  'const x = toDate(ms);',
])('the guard allows %s', (code) => {
  expect(FORBIDDEN.filter(([re]) => re.test(code))).toEqual([]);
});
