import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { HomeBrief, ToolDef } from './bedrock.ts';
import type { ToolRunner } from './run.ts';

export const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:3000/mcp';

/**
 * How long a turn waits on the MCP server. Measured against a local server, connecting took at
 * most 0.7 s and each tool call at most about 1 s (the weekend preview's three simulations), and
 * the deployed server's p99 is 400 ms (decision 94); 15 s also covers a server instance starting
 * cold. add_house_rule compiles with three models at once, and the server gives up on that after
 * 40 s (COMPILE_DEADLINE_MS), so the host waits 45 s for it. The SDK's own default is 60 s.
 */
export const MCP_TIMEOUT_MS = 15_000;
export const RULE_TIMEOUT_MS = 45_000;

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

/**
 * Connect for one turn. Setting up (connecting, the tool list, the home) waits no longer than
 * what's left before the turn's `deadline` (ms since the epoch); each tool call has its own
 * timeout, so one the model started in time finishes.
 */
export async function connectTools(
  options: { url?: string; timeoutMs?: number; ruleTimeoutMs?: number; deadline?: number } = {},
): Promise<Tools> {
  const timeout = { timeout: options.timeoutMs ?? MCP_TIMEOUT_MS };
  const ruleTimeout = { timeout: options.ruleTimeoutMs ?? RULE_TIMEOUT_MS };
  const deadline = options.deadline;
  const setup = () =>
    deadline === undefined
      ? timeout
      : { timeout: Math.max(1, Math.min(timeout.timeout, deadline - Date.now())) };
  const client = new Client({ name: 'shadow-home-host', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(options.url ?? MCP_SERVER_URL));
  let tools: Awaited<ReturnType<Client['listTools']>>['tools'];
  try {
    await client.connect(transport, setup());
    ({ tools } = await client.listTools(undefined, setup()));
  } catch (e) {
    // Don't leave the connection open until the server gives up on it.
    await client.close().catch(() => undefined);
    throw e;
  }
  const views = new Map<string, string>();
  for (const t of tools) {
    const uri = (t._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri;
    if (typeof uri === 'string') views.set(t.name, uri);
  }
  const instructions = client.getInstructions();
  return {
    callTool: (name, args) =>
      client.callTool({ name, arguments: args }, name === 'add_house_rule' ? ruleTimeout : timeout),
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
      const r = await client.callTool({ name: 'get_home_state', arguments: {} }, setup());
      return r.structuredContent as unknown as HomeBrief;
    },
    close: () => client.close(),
  };
}
