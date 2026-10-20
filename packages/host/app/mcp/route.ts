import { log } from '@/log.ts';
import { fromOtherSite, OTHER_SITE } from '@/origin.ts';
import { forward } from '@/proxy.ts';
import { MCP_SERVER_URL, MCP_TIMEOUT_MS } from '@/turn/mcp.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The browser's way to the MCP server: same origin, so views on screen can call tools through
 * the app bridge without the server allowing browser origins. Responses are read whole, since
 * the hosting doesn't stream; the server answers each request in full anyway (stateless). The
 * screen calls only the quick tools (its taps commit, approve and undo; the home card reads the
 * home), so a server that hasn't answered within MCP_TIMEOUT_MS gets a 504.
 */
async function proxy(request: Request): Promise<Response> {
  if (fromOtherSite(request)) return OTHER_SITE();
  const response = await forward(request, MCP_SERVER_URL, MCP_TIMEOUT_MS);
  if (response.status === 504) {
    log('WARNING', 'mcp proxy timed out', { ms: MCP_TIMEOUT_MS }, request.headers);
  }
  return response;
}

export { proxy as DELETE, proxy as GET, proxy as POST };
