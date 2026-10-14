import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { HomeBrief, ToolDef } from './bedrock.ts';
import type { ToolRunner } from './run.ts';

export const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:3000/mcp';

/**
 * A fresh MCP client for one turn. Route handlers keep no state between requests (the host
 * may run on Lambda), so each turn connects, works and closes.
 */
export interface Tools extends ToolRunner {
  /** The tools a model may call: everything not marked for the on-screen app only. */
  modelTools: ToolDef[];
  /** What the server tells every client in `initialize`. */
  instructions?: string;
  /** The home as a model needs it to draft plans. */
  homeBrief(): Promise<HomeBrief>;
  close(): Promise<void>;
}

/** A tool the model may see: no visibility list, or one that includes the model. */
export function visibleToModel(meta: Record<string, unknown> | undefined): boolean {
  const visibility = (meta?.ui as { visibility?: unknown } | undefined)?.visibility;
  return !Array.isArray(visibility) || visibility.includes('model');
}

export async function connectTools(): Promise<Tools> {
  const client = new Client({ name: 'shadow-home-host', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL)));
  const { tools } = await client.listTools();
  const views = new Map<string, string>();
  for (const t of tools) {
    const uri = (t._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri;
    if (typeof uri === 'string') views.set(t.name, uri);
  }
  const instructions = client.getInstructions();
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    resourceUriFor: (name) => views.get(name),
    modelTools: tools
      .filter((t) => visibleToModel(t._meta))
      .map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        inputSchema: t.inputSchema as Record<string, unknown>,
      })),
    ...(instructions ? { instructions } : {}),
    async homeBrief() {
      const r = await client.callTool({ name: 'get_home_state', arguments: {} });
      return r.structuredContent as unknown as HomeBrief;
    },
    close: () => client.close(),
  };
}
