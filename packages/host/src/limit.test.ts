import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { hourlyLimit } from './limit.ts';

test('live turns and speech: at most the limit in any rolling hour, then room as uses age out', () => {
  let t = 0;
  const allow = hourlyLimit(2, () => t);
  expect([allow(), allow(), allow()]).toEqual([true, true, false]);
  t = 60 * 60 * 1000;
  expect([allow(), allow(), allow()]).toEqual([true, true, false]);
});

test("the server's copy is the same file", () => {
  const copy = (pkg: string) =>
    readFileSync(join(import.meta.dirname, `../../${pkg}/src/limit.ts`), 'utf8');
  expect(copy('host')).toBe(copy('server'));
});
