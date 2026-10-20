// Arbitrary and malformed arguments for each of the seven tools, sent as JSON-RPC through the real
// MCP app in process, on each protocol version a client can speak. Whatever arrives, the server
// answers: the arguments are refused with a message, or the result's structuredContent matches
// the tool's output schema and its speech fits the limits. The SDK turns anything a tool's handler
// throws into an error result too, so the only error result that passes is the input refusal.
import { join } from 'node:path';
import { SPEECH_LIMITS, wordCount } from '@shadow-home/engine';
import { loadHome } from '@shadow-home/twin/node';
import type { Hono } from 'hono';
import { expect } from 'vitest';
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
import { isoAt } from './time.ts';
import { APPROVAL_META_KEY } from './view.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const NOW = Date.parse(home.clock.now);
const at = (minutes: number) => isoAt(NOW + minutes * 60_000, home.home.utcOffset);

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

/** Every `speech` in a result, wherever it sits (a commit's fresh preview, an undo's preview). */
function speeches(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const v of value) speeches(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'speech' && v && typeof v === 'object') out.push(v as Record<string, unknown>);
      else speeches(v, out);
    }
  }
  return out;
}

/**
 * The server answered as it should: the arguments refused with a message, or a result that
 * matches the tool's output schema and speaks within the limits. Says which. Arguments that aren't
 * an object are refused as an invalid request; any other protocol error (a request the server
 * couldn't read, or a result that breaks the wire schema) fails.
 */
function expectAnswered(name: Tool, reply: Reply): 'refused' | 'answered' {
  const shown = JSON.stringify(reply).slice(0, 2000);
  expect(reply.status, shown).toBe(200);
  if (reply.error) {
    expect(reply.error.code, shown).toBe(-32602);
    expect(reply.error.message, shown).toMatch(/^Invalid tools\/call request: \S/);
    return 'refused';
  }
  const result = reply.result;
  expect(result, shown).toBeDefined();
  if (result?.isError) {
    expect(result.content?.[0]?.text, shown).toMatch(/^Input validation error: \S/);
    return 'refused';
  }
  const parsed = OUTPUTS[name].safeParse(result?.structuredContent);
  expect(parsed.error, shown).toBeUndefined();
  for (const s of speeches(result?.structuredContent)) {
    const words = (field: 'headline' | 'reason' | 'ask') =>
      typeof s[field] === 'string' ? wordCount(s[field]) : 0;
    expect(words('headline'), shown).toBeLessThanOrEqual(SPEECH_LIMITS.headline);
    expect(words('reason'), shown).toBeLessThanOrEqual(SPEECH_LIMITS.reason);
    expect(words('ask'), shown).toBeLessThanOrEqual(SPEECH_LIMITS.ask);
  }
  return 'answered';
}

/** Plan IDs, their approval tokens and undo tokens the server has handed out. */
interface Known {
  planIds: string[];
  tokens: Record<string, string>;
  undoTokens: string[];
}

/** Keep what a result hands out, for later calls to use. */
function harvest(known: Known, reply: Reply): void {
  const result = reply.result;
  if (!result || result.isError) return;
  const walk = (value: unknown) => {
    if (Array.isArray(value)) for (const v of value) walk(v);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k === 'planId' && typeof v === 'string' && !known.planIds.includes(v)) {
          known.planIds.push(v);
        } else if (k === 'undoToken' && typeof v === 'string' && !known.undoTokens.includes(v)) {
          known.undoTokens.push(v);
        } else walk(v);
      }
    }
  };
  walk(result.structuredContent);
  Object.assign(known.tokens, result._meta?.[APPROVAL_META_KEY] ?? {});
}

// ---- Valid arguments, to start from ----

const RULE_KEYS = ['priority', 'refuse', 'template', 'params'];
/** The demo home's own rules, as a compiler would hand them over. */
const COMPILED = home.rules.map((r) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => RULE_KEYS.includes(k))),
);

const PREVIEWS = [
  {
    intent: 'Dim the living room to 30 percent.',
    actions: [{ device: 'light_living', set: { brightness: 30 } }],
  },
  {
    intent: 'Turn off the garage freezer.',
    requestedBy: 'om',
    actions: [{ device: 'plug_garage_freezer', set: { onOff: false } }],
  },
  {
    intent: 'Run the dishwasher at 2.',
    actions: [{ device: 'dishwasher', set: { onOff: true }, at: at(8 * 60 + 15) }],
  },
  {
    intent: 'TV off and the freezer off.',
    actions: [
      { device: 'plug_tv', set: { onOff: false } },
      { device: 'plug_garage_freezer', set: { onOff: false } },
    ],
  },
  {
    intent: "I'm away for the weekend, set the house to away.",
    requestedBy: 'om',
    presenceSchedule: [{ from: at(15), to: at(48 * 60 + 15), presence: 'nobody' }],
    planEnd: at(48 * 60 + 15),
    actions: [
      { device: 'thermostat_main', set: { heatingSetpointC: 10 } },
      { group: 'all_lights', set: { onOff: false } },
      { routine: 'coffee_at_7', pauseUntil: at(48 * 60) },
      { mode: 'away' },
    ],
  },
];

/** Previews each plan above and commits the first, so there are plan IDs and tokens to use. */
async function seed(app: Hono): Promise<Known> {
  const known: Known = { planIds: [], tokens: {}, undoTokens: [] };
  const valid = async (tool: Tool, args: unknown) => {
    const reply = await send(app, '2025-03-26', tool, args);
    expect(expectAnswered(tool, reply)).toBe('answered');
    harvest(known, reply);
  };
  for (const args of PREVIEWS) await valid('preview_plan', args);
  await valid('commit_plan', { planId: known.planIds[0] });
  expect(known.undoTokens).toHaveLength(1);
  return known;
}

/** Valid arguments for each tool, some using what the server handed out. */
function examples(tool: Tool, known: Known): unknown[] {
  const [planId = '', ...others] = known.planIds;
  switch (tool) {
    case 'get_home_state':
      return [{}, { room: 'garage' }, { room: 'Living room' }];
    case 'preview_plan':
      return PREVIEWS;
    case 'commit_plan':
      return [
        { planId },
        ...others.map((id) => ({ planId: id, confirmed: true })),
        ...others.map((id) => ({ planId: id, safePartOnly: true, confirmed: true })),
      ];
    case 'undo':
      return [
        { token: 'last' },
        ...known.undoTokens.map((token) => ({ token })),
        ...known.undoTokens.map((token) => ({ token, devices: ['light_living'] })),
      ];
    case 'get_activity_log':
      return [{}, { groupBy: 'none', limit: 5 }, { person: 'om', from: at(-60), to: at(60) }];
    case 'add_house_rule':
      return home.rules.map((r, i) => ({ text: r.text, author: r.author, rule: COMPILED[i] }));
    case 'approve_plan':
      return known.planIds.map((id) => ({ planId: id, approvalToken: known.tokens[id] ?? '' }));
  }
}
