import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { HomeBrief } from './bedrock.ts';
import { stepLabel } from './events.ts';
import type { Tools } from './mcp.ts';
import { LIMITED, respondToTurn, type TurnRoute } from './respond.ts';
import { type Beat, scriptedModel } from './scripted.ts';
import { readEvents } from './test-helpers.ts';
import { takeTurn } from './turn.ts';
import type { TurnResponse } from './types.ts';

const beats = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../../fixtures/demo-script.json'), 'utf8'),
  ) as { beats: Beat[] }
).beats;
const WEEKEND = "I'm away for the weekend, set the house to away.";
const VIEW = 'ui://shadow-home/plan-view.html';
const SAID = 'Not safe: the garage would freeze. Do it with 4 fixes instead?';
const home: HomeBrief = {
  now: '2027-01-15T17:45:00-06:00',
  mode: 'home',
  devices: [],
  routines: [],
  presence: {},
};
const preview = {
  content: [{ type: 'text' as const, text: 'UNSAFE (T3)' }],
  structuredContent: {
    planId: 'p1',
    verdict: 'UNSAFE',
    tier: 'T3',
    speech: { headline: 'Not safe: the garage would freeze.', ask: 'Do it with 4 fixes instead?' },
  },
};

/** The MCP server, answering every call with the weekend's UNSAFE preview. */
function fakeTools(ran: string[] = []): Tools {
  return {
    callTool: async (name) => {
      ran.push(name);
      return preview;
    },
    resourceUriFor: () => VIEW,
    modelTools: [],
    homeBrief: async () => home,
    close: async () => undefined,
  };
}

/** The route as it runs with MOCK_MODEL=1: the scripted model, against a stand-in server. */
function scriptedRoute(tools: Tools = fakeTools()): TurnRoute {
  return {
    scripted: true,
    limit: Object.assign(() => 'ok' as const, { retryAfter: () => 0 }),
    take: (input, options) =>
      takeTurn(input, {
        ...options,
        connect: async () => tools,
        model: async (_, h) => scriptedModel(beats, h),
      }),
  };
}

function turnRequest(
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request('http://localhost:3001/api/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}
const STREAM = { accept: 'text/event-stream' };

describe('a turn over HTTP', () => {
  test('without asking for a stream, the answer is the whole turn as JSON, as before', async () => {
    const response = await respondToTurn(
      turnRequest({ text: WEEKEND, history: [] }),
      scriptedRoute(),
    );
    expect(response.headers.get('content-type')).toContain('application/json');
    // The turn as the route sent it before streaming: the scripted model's call, with what the
    // server returned and the view it declares, then the server's speech.
    const step = await scriptedModel(beats, home).next({
      text: WEEKEND,
      history: [],
      thisTurn: [],
    });
    if (!('call' in step)) throw new Error('The weekend line should call a tool');
    const turn: TurnResponse = {
      say: SAID,
      calls: [{ ...step.call, result: preview, resourceUri: VIEW }],
    };
    expect(await response.text()).toBe(JSON.stringify(turn));
  });

  test('the scripted model streams the same events a live one does', async () => {
    const response = await respondToTurn(
      turnRequest({ text: WEEKEND, history: [] }, STREAM),
      scriptedRoute(),
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const events = await readEvents(response);
    const step = { id: 's1', tool: 'preview_plan', label: stepLabel('preview_plan') };
    expect(events.map((e) => e.event)).toEqual(['step', 'step', 'call', 'text', 'done']);
    expect(events.slice(0, 2).map((e) => e.data)).toEqual([
      { ...step, state: 'running' },
      { ...step, state: 'done' },
    ]);
    const { call } = (events[2]?.data ?? {}) as { call?: { name: string } };
    expect(call).toMatchObject({
      name: 'preview_plan',
      arguments: { intent: WEEKEND, requestedBy: 'om' },
      result: preview,
      resourceUri: VIEW,
    });
    expect(events[3]?.data).toEqual({ delta: SAID });
    // `done` is the whole turn, as the JSON answer has it.
    expect(events[4]?.data).toEqual({ say: SAID, calls: [call] });
  });

  test('a turn that fails with nothing done ends with an error the person can retry', async () => {
    const route: TurnRoute = {
      ...scriptedRoute(),
      take: (input, options) =>
        takeTurn(input, {
          ...options,
          connect: () => Promise.reject(new Error('connection refused')),
          model: async () => scriptedModel(beats),
        }),
    };
    const events = await readEvents(
      await respondToTurn(turnRequest({ text: WEEKEND, history: [] }, STREAM), route),
    );
    expect(events).toEqual([
      {
        event: 'error',
        data: { message: "Sorry, I can't reach my assistant model right now.", retryable: true },
      },
    ]);
  });

  test("past the hour's limit: an error that says when to try again, or today's line as JSON", async () => {
    let taken = 0;
    const route: TurnRoute = {
      scripted: false,
      limit: Object.assign(() => 'visitor' as const, { retryAfter: () => 25 * 60_000 }),
      take: async () => {
        taken += 1;
        return { turn: { say: 'Hi.', calls: [] } };
      },
    };
    const streamed = await respondToTurn(turnRequest({ text: 'hi', history: [] }, STREAM), route);
    expect(streamed.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await readEvents(streamed)).toEqual([
      { event: 'error', data: { message: LIMITED, retryable: true, retryAfterMs: 1_500_000 } },
    ]);
    const json = await respondToTurn(turnRequest({ text: 'hi', history: [] }), route);
    expect(await json.json()).toEqual({
      say: "I've had a lot of requests this hour. Try again later.",
      calls: [],
    });
    // A cap of nothing never frees up: no time to come back.
    const never = {
      ...route,
      limit: Object.assign(() => 'instance' as const, { retryAfter: () => Infinity }),
    };
    expect(
      await readEvents(
        await respondToTurn(turnRequest({ text: 'hi', history: [] }, STREAM), never),
      ),
    ).toEqual([{ event: 'error', data: { message: LIMITED, retryable: false } }]);
    expect(taken).toBe(0);
  });

  test('a bad request and one from another site stay plain HTTP, stream or not', async () => {
    const bad = await respondToTurn(turnRequest({ text: '' }, STREAM), scriptedRoute());
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Bad turn request' });
    const elsewhere = await respondToTurn(
      turnRequest(
        { text: WEEKEND, history: [] },
        { ...STREAM, origin: 'https://elsewhere.example' },
      ),
      scriptedRoute(),
    );
    expect(elsewhere.status).toBe(403);
  });

  test('a client that goes away stops the turn: no tool call starts after it', async () => {
    const left = new AbortController();
    const ran: string[] = [];
    let release: () => void = () => {};
    const tools: Tools = {
      ...fakeTools(ran),
      // The home arrives only after the person has gone.
      homeBrief: () =>
        new Promise((r) => {
          release = () => r(home);
        }),
    };
    const response = await respondToTurn(
      turnRequest({ text: WEEKEND, history: [] }, STREAM, left.signal),
      scriptedRoute(tools),
    );
    left.abort();
    release();
    const text = await new Response(response.body).text();
    expect(text).not.toContain('event:');
    expect(ran).toEqual([]);
  });
});
