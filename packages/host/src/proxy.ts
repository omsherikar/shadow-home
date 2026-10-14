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
