import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { serve } from '@hono/node-server';
import {
  createApp,
  initialState,
  manualClock,
  memoryStore,
  ShadowHomeService,
} from '@shadow-home/server';
import { loadHome } from '@shadow-home/twin/node';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bedrockModel } from './bedrock.ts';
import { connectTools } from './mcp.ts';
import { takeTurn } from './turn.ts';
import type { Remembered, TurnResponse } from './types.ts';

// The real MCP server, in process, with the demo home: what an undo returns is the server's own.
const home = loadHome(join(import.meta.dirname, '../../../../fixtures/demo-home.json'));
let url = '';
let close: () => void = () => {};
beforeAll(async () => {
  const service = new ShadowHomeService({
    store: memoryStore(initialState(home)),
    clock: manualClock(Date.parse(home.clock.now)),
    secret: 'unit',
  });
  const server = serve({ fetch: createApp(service).fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  url = `http://localhost:${(server.address() as AddressInfo).port}/mcp`;
  close = () => server.close();
});
afterAll(() => close());

const AWAY = {
  presenceSchedule: [
    { from: '2027-01-15T18:00:00-06:00', to: '2027-01-17T18:00:00-06:00', presence: 'nobody' },
  ],
  planEnd: '2027-01-17T18:00:00-06:00',
};

/** The tool results the model has been shown so far, newest last. */
function results(input: ConverseCommandInput): Record<string, unknown>[] {
  return (input.messages ?? []).flatMap((m) =>
    (m.content ?? []).flatMap((b) =>
      b.toolResult ? [(b.toolResult.content?.[0]?.json ?? {}) as Record<string, unknown>] : [],
    ),
  );
}

/**
 * A model that answers each step with what `steps` says: a tool to call (its arguments worked out
 * from the results so far), or words. It stands in for the live model, which made these calls.
 */
function model(...steps: ((seen: Record<string, unknown>[]) => ContentBlock)[]) {
  const converse = async (input: ConverseCommandInput): Promise<ConverseCommandOutput> => {
    const step = steps.shift();
    if (!step) throw new Error('No step left');
    return {
      $metadata: {},
      output: { message: { role: 'assistant', content: [step(results(input))] } },
    } as ConverseCommandOutput;
  };
  return converse;
}
const callTool =
  (name: string, args: (seen: Record<string, unknown>[]) => unknown) =>
  (seen: Record<string, unknown>[]): ContentBlock => ({
    toolUse: { toolUseId: `t${seen.length}`, name, input: args(seen) as never },
  });
const saying = (text: string) => (): ContentBlock => ({ text });

/** One turn through the host's own loop, against the real server, keeping history as the page does. */
async function turn(
  history: Remembered[],
  text: string,
  converse: ReturnType<typeof model>,
): Promise<TurnResponse> {
  const { turn: out } = await takeTurn(
    { text, history },
    {
      connect: (deadline) => connectTools({ url, deadline }),
      model: async (tools, brief) =>
        bedrockModel({ converse, tools: tools.modelTools, home: brief }),
      deadline: Date.now() + 20_000,
    },
  );
  history.push({ name: 'heard', arguments: { text } });
  for (const c of out.calls) {
    history.push({
      name: c.name,
      arguments: c.arguments,
      ...(c.result.structuredContent
        ? { structuredContent: c.result.structuredContent as Record<string, unknown> }
        : {}),
    });
  }
  history.push({ name: 'said', arguments: { text: out.say } });
  return out;
}

const sc = (out: TurnResponse, i: number) =>
  out.calls[i]?.result.structuredContent as Record<string, unknown>;

describe('undo after the weekend fix, against the real server', () => {
  test('the transcript: blocked, its fix committed, then "Undo that." commits a T1 undo at once', async () => {
    const history: Remembered[] = [];
    // Away mode and heating down, everyone away until Sunday evening: blocked, with a fix.
    const weekend = await turn(
      history,
      "I'm away for the weekend, set the house to away.",
      model(
        callTool('preview_plan', () => ({
          intent: "I'm away for the weekend, set the house to away.",
          requestedBy: 'om',
          actions: [{ mode: 'away' }, { device: 'thermostat_main', set: { heatingSetpointC: 16 } }],
          ...AWAY,
        })),
        saying(''),
      ),
    );
    expect(sc(weekend, 0)).toMatchObject({ verdict: 'UNSAFE', tier: 'T3' });
    expect(weekend.say).toMatch(/^Blocked: .* Do it with \d fixes instead\?$/);

    const fixed = await turn(
      history,
      'Yes.',
      model(
        callTool('commit_plan', () => ({ planId: findRepair(history), confirmed: true })),
        saying(''),
      ),
    );
    expect(sc(fixed, 0)).toMatchObject({ status: 'committed' });
    expect(fixed.say).toMatch(/^Done: \d+ changes, some of it later\.$/);

    // The live model undid, then answered instead of committing; the turn now commits it.
    const undone = await turn(
      history,
      'Undo that.',
      model(
        callTool('undo', () => ({ token: 'last' })),
        saying("I've put things back the way they were."),
        saying(''),
      ),
    );
    expect(undone.calls.map((c) => c.name)).toEqual(['undo', 'commit_plan']);
    expect(sc(undone, 0)).toMatchObject({
      status: 'preview',
      speech: {
        headline: 'Safe: 2 changes, no house rule broken.',
        reason: 'This affects Maya and Sam.',
      },
      preview: { tier: 'T1' },
    });
    expect(sc(undone, 1)).toMatchObject({ status: 'committed' });
    expect(undone.say).toMatch(/^Done: /);
  });

  test("an undo that needs a yes says the engine's question, and a yes commits it", async () => {
    const history: Remembered[] = [];
    // The demo's weekend plan locks the doors; putting it back unlocks the front door: T2.
    const script = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../../fixtures/demo-script.json'), 'utf8'),
    ) as { beats: { say: string; draftPlanExample: unknown[] }[] };
    const beat = script.beats[0] as { say: string; draftPlanExample: unknown[] };
    await turn(
      history,
      beat.say,
      model(
        callTool('preview_plan', () => ({
          intent: beat.say,
          requestedBy: 'om',
          actions: beat.draftPlanExample,
          ...AWAY,
        })),
        saying(''),
      ),
    );
    await turn(
      history,
      'Yes.',
      model(
        callTool('commit_plan', () => ({ planId: findRepair(history), confirmed: true })),
        saying(''),
      ),
    );
    const asked = await turn(
      history,
      'Undo that.',
      model(
        callTool('undo', () => ({ token: 'last' })),
        saying(''),
      ),
    );
    expect(asked.calls.map((c) => c.name)).toEqual(['undo']);
    const undo = sc(asked, 0) as {
      speech: { headline: string; ask: string };
      preview: { tier: string; planId: string };
    };
    expect(undo.preview.tier).toBe('T2');
    expect(asked.say.startsWith(undo.speech.headline)).toBe(true);
    expect(asked.say.endsWith(undo.speech.ask)).toBe(true);
    // The history the page keeps gives the model the undo's plan ID for the yes.
    const yes = await turn(
      history,
      'Yes.',
      model(
        callTool('commit_plan', () => ({ planId: undo.preview.planId, confirmed: true })),
        saying(''),
      ),
    );
    expect(sc(yes, 0)).toMatchObject({ status: 'committed' });
    expect(yes.say).toMatch(/^Done: /);
  });
});

/** The fix on offer in the last check the page kept. */
function findRepair(history: Remembered[]): string {
  const check = history.findLast((h) => h.name === 'preview_plan')?.structuredContent as
    | { repair?: { planId: string } }
    | undefined;
  if (!check?.repair) throw new Error('No fix on offer');
  return check.repair.planId;
}
