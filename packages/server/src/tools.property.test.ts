// Arbitrary and malformed arguments for each of the seven tools, sent as JSON-RPC through the real
// MCP app in process, on each protocol version a client can speak. Whatever arrives, the server
// answers: the arguments are refused with a message, or the result's structuredContent matches
// the tool's output schema and its speech fits the limits. The SDK turns anything a tool's handler
// throws into an error result too, so the only error result that passes is the input refusal.
import { join } from 'node:path';
import { SPEECH_LIMITS, wordCount } from '@shadow-home/engine';
import { loadHome } from '@shadow-home/twin/node';
import fc from 'fast-check';
import type { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
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
import { plainText } from './text.ts';
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
const TOOLS = Object.keys(OUTPUTS) as Tool[];

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

/** Answered calls on each protocol version. */
const byEra = () => Object.fromEntries(ERAS.map((era) => [era, 0])) as Record<Era, number>;

/**
 * Each protocol version had calls answered, not only refused, so one that fails as a whole (a
 * missing 2026-07-28 envelope, say, refuses every call) can't hide behind the others.
 */
function expectEveryEra(answered: Record<Era, number>): void {
  for (const era of ERAS) expect(answered[era], era).toBeGreaterThan(0);
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

// ---- What else gets sent ----

/** Values that tend to break things: prototype names, blank and control text, odd numbers. */
const nasty = fc.constantFrom<unknown>(
  '',
  ' ',
  '\u0000',
  '\n\t',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'last',
  'nobody',
  'everyone',
  'LOCKED',
  '\ud800',
  String.fromCodePoint(0x202e),
  'x'.repeat(301),
  0,
  -1,
  0.5,
  1e308,
  -1e308,
  2 ** 53 + 2,
  true,
  false,
  null,
  [],
  {},
);
const junk = fc.oneof(nasty, fc.jsonValue({ maxDepth: 2 }));

// Plans the input schema accepts, with odd contents: names the home doesn't have, prototype names,
// values of the wrong type or out of range, times days away or in years 0 and 9999, and words with
// control characters in them. These reach the tools' own code and the engine.

const time = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: -3 * 24 * 60, max: 8 * 24 * 60 }).map(at) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      '0000-01-01T00:00:00Z',
      '9999-12-31T23:59:59-23:59',
      '2027-01-15T18:00:00.123456789+05:30',
    ),
  },
);
const NAMES = [
  ...home.devices.map((d) => d.id),
  ...Object.keys(home.groups),
  ...home.routines.map((r) => r.id),
  ...home.rooms.flatMap((r) => [r.id, r.name]),
  'home',
  'away',
];
const PROTO = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
const name = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...NAMES) },
  { weight: 1, arbitrary: fc.constantFrom(...PROTO) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 100 }) },
);
const ATTRS = [
  ...new Set(
    home.devices.flatMap((d) => [...Object.keys(d.capabilities), ...Object.keys(d.state)]),
  ),
];
const attr = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...ATTRS) },
  { weight: 1, arbitrary: fc.constantFrom(...PROTO) },
  { weight: 1, arbitrary: fc.string({ maxLength: 100 }) },
);
const value = fc.oneof(
  fc.boolean(),
  fc.integer({ min: -50, max: 150 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom('LOCKED', 'UNLOCKED', 'heat', 'off', 'cool', 'auto', 'on'),
  fc.string({ maxLength: 100 }),
);
const member = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom('om', 'maya', 'sam') },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 40 }) },
);
const words = fc.oneof(
  fc.constantFrom(...PREVIEWS.map((p) => p.intent), ...home.rules.map((r) => r.text)),
  fc.string({ minLength: 1, maxLength: 300 }),
  fc.string({ unit: 'binary', minLength: 1, maxLength: 40 }),
);

const set = fc.dictionary(attr, value, { minKeys: 1, maxKeys: 3 });
const action = fc.oneof(
  fc.record({ device: name, set, at: time }, { requiredKeys: ['device', 'set'] }),
  fc.record({ group: name, set, at: time }, { requiredKeys: ['group', 'set'] }),
  fc.record({ routine: name, pauseUntil: time }),
  fc.record({ mode: name, at: time }, { requiredKeys: ['mode'] }),
);
const presence = fc.oneof(
  fc.constantFrom('nobody', 'everyone'),
  fc.record({ home: fc.array(member, { maxLength: 3 }) }),
);
const plan = fc.record(
  {
    actions: fc.array(action, { minLength: 1, maxLength: 4 }),
    intent: words.filter((w) => plainText(w) !== ''),
    requestedBy: member,
    presenceSchedule: fc.array(fc.record({ from: time, to: time, presence }), { maxLength: 3 }),
    planEnd: time,
  },
  { requiredKeys: ['actions', 'intent'] },
);

// Arguments the input schema refuses: a valid example with a value replaced (by junk, or by a
// value meant for another field), a key left out, or a key it doesn't expect; or anything at all.

/** One change to a valid example. */
interface Edit {
  pick: number;
  kind: 'replace' | 'drop' | 'add';
  to: unknown;
}
const edit: fc.Arbitrary<Edit> = fc.record({
  pick: fc.nat(),
  kind: fc.constantFrom('replace', 'drop', 'add'),
  to: fc.oneof(name, attr, value, time, member, words, junk),
});

type Parent = Record<string, unknown> | unknown[];

/** `base` with each edit made at some place in it (the whole of it, or any value inside). */
function edited(base: unknown, edits: Edit[]): unknown {
  let out = structuredClone(base);
  for (const { pick, kind, to } of edits) {
    const spots: { parent: Parent | null; key: string }[] = [{ parent: null, key: '' }];
    const walk = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      for (const [key, child] of Object.entries(v)) {
        spots.push({ parent: v as Parent, key });
        walk(child);
      }
    };
    walk(out);
    const { parent, key } = spots[pick % spots.length] ?? { parent: null, key: '' };
    const target = parent ? (parent as Record<string, unknown>)[key] : out;
    if (kind === 'add' && target && typeof target === 'object' && !Array.isArray(target)) {
      (target as Record<string, unknown>).extra = to;
    } else if (!parent) out = to;
    else if (kind === 'drop' && !Array.isArray(parent)) delete parent[key];
    else (parent as Record<string, unknown>)[key] = to;
  }
  return out;
}

/** A valid example for the tool, with a few edits. */
const editedFrom = (valid: unknown[], most: number) =>
  fc
    .tuple(fc.constantFrom(...valid), fc.array(edit, { minLength: 1, maxLength: most }))
    .map(([base, edits]) => edited(base, edits));

/** Arguments for a tool: anything at all, an edited example, or (for a preview) a built plan. */
function argsFor(tool: Tool, known: Known): fc.Arbitrary<unknown> {
  const anything = fc.oneof(
    fc.constant(undefined),
    fc.jsonValue({ maxDepth: 3 }),
    fc.dictionary(fc.string(), junk, { maxKeys: 4 }),
  );
  const near = editedFrom(examples(tool, known), 3);
  return tool === 'preview_plan'
    ? fc.oneof(
        { weight: 1, arbitrary: anything },
        { weight: 2, arbitrary: near },
        { weight: 3, arbitrary: plan },
      )
    : fc.oneof({ weight: 1, arbitrary: anything }, { weight: 3, arbitrary: near });
}

describe('every tool answers whatever arguments it is sent', { timeout: 60_000 }, () => {
  test.each(TOOLS)('%s', async (tool) => {
    const { app } = fresh();
    const known = await seed(app);
    const seen = { refused: 0, answered: 0 };
    const answered = byEra();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ERAS), argsFor(tool, known), async (era, args) => {
        const outcome = expectAnswered(tool, await send(app, era, tool, args));
        seen[outcome]++;
        if (outcome === 'answered') answered[era]++;
      }),
      {
        numRuns: 40,
        examples: examples(tool, known).map((args, i) => [ERAS[i % ERAS.length] as Era, args]),
      },
    );
    // Some arguments got past the input schema, so the tools' own code was reached.
    expect(seen.answered).toBeGreaterThan(0);
    expect(seen.refused).toBeGreaterThan(0);
    expectEveryEra(answered);
  });
});

// ---- Calls in sequence, passing along what the server hands out ----

type Step =
  | { tool: 'preview_plan'; args: unknown }
  | { tool: 'commit_plan'; plan: number; confirmed: unknown; safePartOnly: unknown }
  | { tool: 'approve_plan'; plan: number; token: 'own' | number }
  | { tool: 'undo'; token: 'last' | number; devices: unknown }
  | { tool: 'get_activity_log' | 'get_home_state' | 'add_house_rule'; args: unknown }
  | { minutes: number };

/** Left out, `arb`, or now and then junk. */
const optional = <T>(arb: fc.Arbitrary<T>) =>
  fc.option(fc.oneof({ weight: 8, arbitrary: arb }, { weight: 1, arbitrary: junk }), {
    nil: undefined,
  });
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      tool: fc.constant('preview_plan' as const),
      args: fc.oneof(fc.constantFrom(...PREVIEWS), plan),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      tool: fc.constant('commit_plan' as const),
      plan: fc.nat(),
      confirmed: optional(fc.boolean()),
      safePartOnly: optional(fc.boolean()),
    }),
  },
  fc.record({
    tool: fc.constant('approve_plan' as const),
    plan: fc.nat(),
    token: fc.oneof(fc.constant('own' as const), fc.nat()),
  }),
  fc.record({
    tool: fc.constant('undo' as const),
    token: fc.oneof(fc.constant('last' as const), fc.nat()),
    devices: optional(fc.array(name, { maxLength: 3 })),
  }),
  ...(['get_activity_log', 'get_home_state', 'add_house_rule'] as const).map((tool) =>
    fc.record({
      tool: fc.constant(tool),
      args: fc.oneof(
        fc.constantFrom(...examples(tool, { planIds: [], tokens: {}, undoTokens: [] })),
        editedFrom(examples(tool, { planIds: [], tokens: {}, undoTokens: [] }), 2),
      ),
    }),
  ),
  // A few minutes, inside a plan ID's five; or up to half a day, which routines fire in.
  fc.record({
    minutes: fc.oneof(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 5, max: 12 * 60 })),
  }),
);

/** The `i`th of `list`, wrapping round; undefined when there are none. */
const nth = <T>(list: T[], i: number): T | undefined => list[i % Math.max(1, list.length)];

/** A step's tool and arguments, using what the server has handed out so far. */
function call(s: Exclude<Step, { minutes: number }>, known: Known): [Tool, unknown] {
  switch (s.tool) {
    case 'commit_plan':
      return [
        s.tool,
        {
          planId: nth(known.planIds, s.plan) ?? 'sh1.none.none',
          confirmed: s.confirmed,
          safePartOnly: s.safePartOnly,
        },
      ];
    case 'approve_plan': {
      const planId = nth(known.planIds, s.plan) ?? 'sh1.none.none';
      const tokens = Object.values(known.tokens);
      const token = s.token === 'own' ? known.tokens[planId] : nth(tokens, s.token);
      return [s.tool, { planId, approvalToken: token ?? 'none' }];
    }
    case 'undo': {
      const token = s.token === 'last' ? 'last' : (nth(known.undoTokens, s.token) ?? 'last');
      return [s.tool, { token, devices: s.devices }];
    }
    default:
      return [s.tool, s.args];
  }
}

describe('calls in sequence', { timeout: 60_000 }, () => {
  test('passing plan IDs, approval tokens and undo tokens along, as time moves, every call is answered', async () => {
    const seen = { committed: 0, undone: 0 };
    const answered = byEra();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ERAS),
        fc.array(step, { minLength: 1, maxLength: 8 }),
        async (era, steps) => {
          const { app, clock } = fresh();
          const known: Known = { planIds: [], tokens: {}, undoTokens: [] };
          for (const s of steps) {
            if ('minutes' in s) {
              clock.advance(s.minutes * 60_000);
              continue;
            }
            const [tool, args] = call(s, known);
            const reply = await send(app, era, tool, args);
            if (expectAnswered(tool, reply) === 'answered') answered[era]++;
            harvest(known, reply);
            const out = reply.result?.structuredContent as { status?: string } | undefined;
            if (tool === 'commit_plan' && out?.status === 'committed') seen.committed++;
            if (tool === 'undo' && out?.status === 'preview') seen.undone++;
          }
        },
      ),
      {
        numRuns: 15,
        // Preview, commit, undo and commit the undo, so those paths never depend on luck; run
        // past the end of the forecast, where a long-running local server ends up; and commit a
        // safe part. One on each protocol version.
        examples: [
          [
            '2025-03-26',
            [
              { tool: 'preview_plan', args: PREVIEWS[0] },
              { tool: 'commit_plan', plan: 0, confirmed: undefined, safePartOnly: undefined },
              { tool: 'undo', token: 'last', devices: undefined },
              { tool: 'approve_plan', plan: 1, token: 'own' },
              { tool: 'commit_plan', plan: 1, confirmed: true, safePartOnly: undefined },
              { minutes: 90 },
              { tool: 'get_activity_log', args: {} },
            ],
          ],
          [
            '2026-07-28',
            [
              ...Array.from({ length: 7 }, () => ({ minutes: 12 * 60 })),
              { tool: 'preview_plan', args: PREVIEWS[4] },
              { tool: 'get_home_state', args: {} },
            ],
          ],
          [
            '2025-11-25',
            [
              { tool: 'preview_plan', args: PREVIEWS[3] },
              { tool: 'commit_plan', plan: 0, confirmed: true, safePartOnly: true },
              { tool: 'get_home_state', args: { room: 'garage' } },
            ],
          ],
        ],
      },
    );
    expect(seen.committed).toBeGreaterThan(0);
    expect(seen.undone).toBeGreaterThan(0);
    expectEveryEra(answered);
  });
});
