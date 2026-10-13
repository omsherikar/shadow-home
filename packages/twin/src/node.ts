// Node-only helpers. Kept out of the main entry so packages/engine never pulls in node:fs.
import { readFileSync } from 'node:fs';
import { type Home, homeSchema, type Plan, planSchema } from './schema.ts';
import { validateHome } from './validate.ts';

/** Read, parse and cross-check a home fixture. Throws with every problem listed. */
export function loadHome(path: string): Home {
  const home = homeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const problems = validateHome(home);
  if (problems.length > 0) {
    throw new Error(`${path} is inconsistent:\n- ${problems.join('\n- ')}`);
  }
  return home;
}

/** Read and parse a plan file (a bench plan or a recorded plan). */
export function loadPlan(path: string): Plan {
  return planSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
