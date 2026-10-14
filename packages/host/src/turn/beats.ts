import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Beat } from './scripted.ts';

/** The demo lines and their plans. DEMO_SCRIPT overrides the path (a deploy bundles its own copy). */
export async function loadBeats(): Promise<Beat[]> {
  const path = process.env.DEMO_SCRIPT ?? join(process.cwd(), '../../fixtures/demo-script.json');
  const script = JSON.parse(await readFile(path, 'utf8')) as { beats: Beat[] };
  return script.beats;
}
