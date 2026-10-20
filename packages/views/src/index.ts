import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export * as planScreen from './plan-view/screen.ts';
export {
  APPROVAL_META_KEY,
  NAMES_META_KEY,
  type Names,
  TEMPERATURES_META_KEY,
  type TemperatureTrace,
} from './plan-view/types.ts';

/** The plan view: diff, timeline, chain of causes and controls for preview, commit and undo. */
export const PLAN_VIEW_URI = 'ui://shadow-home/plan-view.html';
export const VIEW_MIME = 'text/html;profile=mcp-app';

const DIST = join(import.meta.dirname, '../dist');
const cache = new Map<string, string>();

/** The built plan view, one self-contained HTML file. */
export function planViewHtml(): string {
  return built('plan-view.html');
}

function built(file: string): string {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = readFileSync(join(DIST, file), 'utf8');
  } catch {
    throw new Error(`${file} isn't built. Run: npm run build -w @shadow-home/views`);
  }
  cache.set(file, html);
  return html;
}
