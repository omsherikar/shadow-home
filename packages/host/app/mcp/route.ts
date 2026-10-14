import { fromOtherSite, OTHER_SITE } from '@/origin.ts';
import { FORWARD_REQUEST, FORWARD_RESPONSE, pick } from '@/proxy.ts';
import { MCP_SERVER_URL } from '@/turn/mcp.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The browser's way to the MCP server: same origin, so views on screen can call tools through
 * the app bridge without the server allowing browser origins. Responses are read whole, since
 * the hosting doesn't stream; the server answers each request in full anyway (stateless).
 */
async function proxy(request: Request): Promise<Response> {
  if (fromOtherSite(request)) return OTHER_SITE();
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const upstream = await fetch(MCP_SERVER_URL, {
    method: request.method,
    headers: pick(request.headers, FORWARD_REQUEST),
    ...(hasBody ? { body: await request.text() } : {}),
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: pick(upstream.headers, FORWARD_RESPONSE),
  });
}

export { proxy as DELETE, proxy as GET, proxy as POST };
