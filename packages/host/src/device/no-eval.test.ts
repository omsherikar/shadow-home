import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { util } from 'zod/v4/core';
import './no-eval.ts';

test("the device page turns zod's compiling off before any module builds a schema", () => {
  // Imports run in order, so the first one runs before the MCP client and the app bridge.
  const page = readFileSync(join(import.meta.dirname, 'Device.tsx'), 'utf8');
  expect(page.match(/^import .*$/m)?.[0]).toBe("import './no-eval.ts';");
  // Node allows `new Function`, so zod would say yes here had it probed: it didn't.
  expect(util.allowsEval.value).toBe(false);
});
