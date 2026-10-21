import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { HomeBrief } from './bedrock.ts';
import type { Tools } from './mcp.ts';
import { respondToTurn, type TurnRoute } from './respond.ts';
import { type Beat, scriptedModel } from './scripted.ts';
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
});
