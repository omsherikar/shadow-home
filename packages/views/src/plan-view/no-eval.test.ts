import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { util } from 'zod/v4/core';
import './no-eval.ts';

test("the plan view turns zod's compiling off before any module builds a schema", () => {
  // Imports run in order, so the first one runs before the app bridge builds its schemas.
  const entry = readFileSync(join(import.meta.dirname, 'main.tsx'), 'utf8');
  expect(entry.match(/^import .*$/m)?.[0]).toBe("import './no-eval.ts';");
  // Node allows `new Function`, so zod would say yes here had it probed: it didn't.
  expect(util.allowsEval.value).toBe(false);
});
