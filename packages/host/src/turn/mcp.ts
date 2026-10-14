import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ToolRunner } from './run.ts';

export const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:3000/mcp';

/**
 * A fresh MCP client for one turn. Route handlers keep no state between requests (the host
 * may run on Lambda), so each turn connects, works and closes.
 */
export async function connectTools(): Promise<ToolRunner & { close(): Promise<void> }> {
  const client = new Client({ name: 'shadow-home-host', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL)));
  const { tools } = await client.listTools();
  const views = new Map<string, string>();
  for (const t of tools) {
    const uri = (t._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri;
    if (typeof uri === 'string') views.set(t.name, uri);
  }
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    resourceUriFor: (name) => views.get(name),
    close: () => client.close(),
  };
}
