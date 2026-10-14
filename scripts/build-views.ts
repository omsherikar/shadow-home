import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Vitest global setup: bundle the MCP App views into packages/views/dist. */
export function setup(): void {
  const script = join(import.meta.dirname, '../packages/views/scripts/build.ts');
  execFileSync(process.execPath, [script], { stdio: 'inherit' });
}
