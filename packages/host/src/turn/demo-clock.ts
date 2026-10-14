import { MCP_SERVER_URL } from './mcp.ts';
import { type Beat, bestBeat, normalise } from './scripted.ts';

/** The server's demo controls, next to its MCP endpoint (only when it runs with SHADOW_HOME_DEMO=1). */
export const DEMO_URL = MCP_SERVER_URL.replace(/\/mcp$/, '/demo');

/**
 * Before a demo line is handled, move home time to the scene it belongs to ("Sunday evening"),
 * so the demo runs with no manual steps. The server only ever moves time forward.
 */
export async function sceneTimeFor(text: string, beats: Beat[]): Promise<string | null> {
  const now = bestBeat(normalise(text), beats)?.context?.now;
  if (!now) return null;
  const res = await fetch(`${DEMO_URL}/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ now }),
  });
  if (!res.ok) throw new Error(`demo clock: ${res.status}`);
  return ((await res.json()) as { homeNow: string }).homeNow;
}

export async function resetDemo(): Promise<string> {
  const res = await fetch(`${DEMO_URL}/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`demo reset: ${res.status}`);
  return ((await res.json()) as { homeNow: string }).homeNow;
}
