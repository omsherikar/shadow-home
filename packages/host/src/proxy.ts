/** Request headers the MCP proxy passes on: the protocol's, and nothing that names the browser. */
export const FORWARD_REQUEST = [
  'accept',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
] as const;

/** Response headers the browser's MCP client reads. */
export const FORWARD_RESPONSE = ['content-type', 'mcp-protocol-version', 'mcp-session-id'] as const;

export function pick(from: Headers, names: readonly string[]): Headers {
  const out = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

/**
 * The browser's request passed on to the MCP server, with only the protocol's headers each way,
 * and the answer read whole. A server that hasn't answered within `ms` gets a 504.
 */
export async function forward(
  request: Request,
  url: string,
  ms: number,
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const signal = AbortSignal.timeout(ms);
  try {
    const upstream = await send(url, {
      method: request.method,
      headers: pick(request.headers, FORWARD_REQUEST),
      ...(hasBody ? { body: await request.text() } : {}),
      signal,
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: pick(upstream.headers, FORWARD_RESPONSE),
    });
  } catch (e) {
    if (!signal.aborted) throw e;
    return Response.json({ error: 'The Shadow Home server took too long' }, { status: 504 });
  }
}
