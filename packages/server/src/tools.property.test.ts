// Arbitrary and malformed arguments for each of the seven tools, sent as JSON-RPC through the real
// MCP app in process, on each protocol version a client can speak. Whatever arrives, the server
// answers: the arguments are refused with a message, or the result's structuredContent matches
// the tool's output schema and its speech fits the limits. The SDK turns anything a tool's handler
// throws into an error result too, so the only error result that passes is the input refusal.
import { join } from 'node:path';
import { loadHome } from '@shadow-home/twin/node';
import type { Hono } from 'hono';
import type { z } from 'zod';
import { createApp } from './app.ts';
import { type ManualClock, manualClock } from './clock.ts';
import { initialState } from './live-home.ts';
import {
  addRuleOutput,
  approveOutput,
  commitOutput,
  homeStateOutput,
  logOutput,
  previewOutput,
  undoOutput,
} from './schemas.ts';
import { ShadowHomeService } from './service.ts';
import { memoryStore } from './store.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const NOW = Date.parse(home.clock.now);

const OUTPUTS = {
  get_home_state: homeStateOutput,
  preview_plan: previewOutput,
  commit_plan: commitOutput,
  undo: undoOutput,
  get_activity_log: logOutput,
  add_house_rule: addRuleOutput,
  approve_plan: approveOutput,
} satisfies Record<string, z.ZodType>;
type Tool = keyof typeof OUTPUTS;

// Alexa+ speaks 2025-03-26; 2025-11-25 and 2026-07-28 are the other clients the server serves.
const ERAS = ['2025-03-26', '2025-11-25', '2026-07-28'] as const;
type Era = (typeof ERAS)[number];
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'fuzz', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** A JSON-RPC reply: a protocol error, or a tool result. */
interface Reply {
  status: number;
  error?: { code: number; message: string };
  result?: {
    isError?: boolean;
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
  };
}

/** A home of its own, with a clock the test moves, behind the real HTTP app. */
function fresh(): { app: Hono; clock: ManualClock } {
  const clock = manualClock(NOW);
  const service = new ShadowHomeService({
    store: memoryStore(initialState(home)),
    clock,
    secret: 'fuzz',
  });
  return { app: createApp(service), clock };
}

/** One tools/call, read whole whether it comes back as JSON or as one SSE event. */
async function send(app: Hono, era: Era, name: Tool, args: unknown): Promise<Reply> {
  const modern = era === '2026-07-28';
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': era,
      ...(modern ? { 'mcp-method': 'tools/call', 'mcp-name': name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args, ...(modern ? { _meta: ENVELOPE } : {}) },
    }),
  });
  const text = await res.text();
  const sse = res.headers.get('content-type')?.startsWith('text/event-stream');
  const json = sse ? /^data: (.*)$/m.exec(text)?.[1] : text;
  return { status: res.status, ...(JSON.parse(json ?? '{}') as Omit<Reply, 'status'>) };
}
