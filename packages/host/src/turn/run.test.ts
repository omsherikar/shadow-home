import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, test } from 'vitest';
import { anthropicConverse, type MessagesApi } from './anthropic.ts';
import { bedrockModel, type HomeBrief } from './bedrock.ts';
import { stepLabel, type TurnEvent } from './events.ts';
import { runTurn, TurnDeadlineError, TurnStoppedError, within } from './run.ts';
import { fakeApi, reply } from './test-helpers.ts';
import type { Model, StepOptions } from './types.ts';

const never = () => new Promise<never>(() => {});
const committed = {
  callTool: async () => ({
    content: [{ type: 'text' as const, text: 'committed' }],
    structuredContent: { status: 'committed', speech: { headline: 'Done: TV off.' } },
  }),
  resourceUriFor: () => undefined,
};

describe('a turn that runs out of time', () => {
  test('a model that never answers: the turn gives up, so the person hears the apology', async () => {
    const model = { next: never };
    await expect(
      runTurn(model, committed, { text: 'TV off', history: [] }, { deadline: Date.now() + 20 }),
    ).rejects.toBeInstanceOf(TurnDeadlineError);
  });

  test('after a tool ran: what it did is said, and the late step is never acted on', async () => {
    let step = 0;
    let calls = 0;
    const model = {
      async next() {
        step += 1;
        if (step === 1) return { call: { name: 'commit_plan', arguments: { planId: 'p1' } } };
        return never();
      },
    };
    const tools = {
      ...committed,
      callTool: () => {
        calls += 1;
        return committed.callTool();
      },
    };
    const turn = await runTurn(
      model,
      tools,
      { text: 'yes', history: [] },
      { deadline: Date.now() + 50 },
    );
    expect(turn).toMatchObject({ say: 'Done: TV off.' });
    expect(calls).toBe(1);
  });

  test('no model call starts once the deadline has passed, after a slow tool call', async () => {
    let steps = 0;
    const model = {
      async next() {
        steps += 1;
        return {
          call: { name: 'add_house_rule', arguments: { text: 'Porch light off at night' } },
        };
      },
    };
    const slow = {
      ...committed,
      callTool: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return committed.callTool();
      },
    };
    const turn = await runTurn(
      model,
      slow,
      { text: 'Add a rule', history: [] },
      { deadline: Date.now() + 30 },
    );
    expect(steps).toBe(1);
    expect(turn).toMatchObject({ say: 'Done: TV off.' });
  });
});

describe('a call left behind at the deadline', () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  afterEach(() => {
    process.off('unhandledRejection', record);
  });

  test('failing later is never an unhandled rejection, which would be logged whole', async () => {
    process.on('unhandledRejection', record);
    const failsLater = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('a message that quotes the conversation')), 10),
    );
    await expect(within(failsLater, 0)).rejects.toBeInstanceOf(TurnDeadlineError);
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
  });
});

const home: HomeBrief = {
  now: '2027-01-15T17:45:00-06:00',
  mode: 'home',
  devices: [{ id: 'thermostat_main', name: 'Main thermostat', room: 'Living room', state: {} }],
  routines: [],
  presence: { om: 'home' },
};
const offered = [
  { name: 'preview_plan', description: 'Check a plan', inputSchema: { type: 'object' } },
  { name: 'commit_plan', description: 'Commit', inputSchema: { type: 'object' } },
];
const unsafe = {
  content: [{ type: 'text' as const, text: 'UNSAFE (T3)' }],
  structuredContent: {
    planId: 'p1',
    verdict: 'UNSAFE',
    tier: 'T3',
    speech: {
      headline: 'Not safe: the garage would freeze.',
      ask: 'Do it with 4 fixes instead?',
    },
    violations: [
      {
        rule: 'R3',
        text: 'Keep the garage above 4 °C',
        author: 'om',
        firstAt: '2027-01-16T22:37:00-06:00',
      },
    ],
  },
};
const VIEW = 'ui://shadow-home/plan-view.html';

/** The events as the screen would follow them: consecutive words joined into one. */
function followed(events: TurnEvent[]) {
  const out: unknown[] = [];
  for (const e of events) {
    const last = out.at(-1) as { text?: string } | undefined;
    if (e.event === 'text' && last?.text !== undefined) last.text += e.data.delta;
    else if (e.event === 'text') out.push({ text: e.data.delta });
    else if (e.event === 'step') out.push({ step: `${e.data.id} ${e.data.tool} ${e.data.state}` });
    else out.push({ [e.event]: e.event === 'call' ? e.data.call.name : e.data });
  }
  return out;
}

describe('a turn as it happens', () => {
  test("a typical preview: the step, the call, then the engine's headline, the model's explanation and the engine's question; words before the call are never said", async () => {
    const { api } = fakeApi(
      reply(
        [
          { type: 'text', text: 'The front door is now unlocked.' },
          { type: 'tool_use', id: 'toolu_1', name: 'preview_plan', input: { intent: 'away' } },
        ],
        'tool_use',
      ),
      reply([
        {
          type: 'text',
          text: 'Om set that rule to keep the garage pipes from freezing. Shall I fix it?',
        },
      ]),
    );
    const model = bedrockModel({ converse: anthropicConverse(api), tools: offered, home });
    const ran: string[] = [];
    const tools = {
      callTool: async (name: string) => {
        ran.push(name);
        return unsafe;
      },
      resourceUriFor: () => VIEW,
    };
    const events: TurnEvent[] = [];
    const turn = await runTurn(
      model,
      tools,
      { text: "I'm away for the weekend", history: [] },
      { emit: (e) => events.push(e) },
    );
    const explanation = 'Om set that rule to keep the garage pipes from freezing.';
    expect(followed(events)).toEqual([
      { step: 's1 preview_plan running' },
      { step: 's1 preview_plan done' },
      { call: 'preview_plan' },
      { text: `Not safe: the garage would freeze. ${explanation} Do it with 4 fixes instead?` },
    ]);
    // A piece at a time: the headline as the check returned, the model's sentence once it passed
    // (its own question never did), and the engine's question last.
    expect(events.flatMap((e) => (e.event === 'text' ? [e.data.delta] : []))).toEqual([
      'Not safe: the garage would freeze.',
      ` ${explanation}`,
      ' Do it with 4 fixes instead?',
    ]);
    expect(events[events.findIndex((e) => e.event === 'step')]).toEqual({
      event: 'step',
      data: { id: 's1', tool: 'preview_plan', label: stepLabel('preview_plan'), state: 'running' },
    });
    // The call event is the call as the whole turn reports it.
    expect(events.find((e) => e.event === 'call')?.data).toEqual({ call: turn.calls[0] });
    expect(turn.calls[0]).toMatchObject({ name: 'preview_plan', resourceUri: VIEW });
    expect(ran).toEqual(['preview_plan']);
    expect(turn.say).toBe(
      `Not safe: the garage would freeze. ${explanation} Do it with 4 fixes instead?`,
    );
  });

  test('a later "why?": the check\'s headline first, then the model\'s sentences', async () => {
    const { api } = fakeApi(
      reply([{ type: 'text', text: "Om's rule is about the garage. It's fine, honestly." }]),
    );
    const model = bedrockModel({ converse: anthropicConverse(api), tools: offered, home });
    const events: TurnEvent[] = [];
    const history = [
      { name: 'preview_plan', arguments: {}, structuredContent: unsafe.structuredContent },
    ];
    const turn = await runTurn(
      model,
      { callTool: async () => unsafe, resourceUriFor: () => VIEW },
      { text: 'Why?', history },
      { emit: (e) => events.push(e) },
    );
    expect(events.flatMap((e) => (e.event === 'text' ? [e.data.delta] : []))).toEqual([
      'Not safe: the garage would freeze.',
      " Om's rule is about the garage.",
    ]);
    expect(turn).toEqual({
      say: "Not safe: the garage would freeze. Om's rule is about the garage.",
      calls: [],
    });
  });

  test("a reply that claims a verdict is never sent: the engine's words go instead", async () => {
    const { api } = fakeApi(
      reply([{ type: 'tool_use', id: 'toolu_1', name: 'preview_plan', input: {} }], 'tool_use'),
      reply([{ type: 'text', text: "Good news. It's safe, so I'll go ahead. Okay?" }]),
    );
    const model = bedrockModel({ converse: anthropicConverse(api), tools: offered, home });
    const events: TurnEvent[] = [];
    const turn = await runTurn(
      model,
      { callTool: async () => unsafe, resourceUriFor: () => VIEW },
      { text: "I'm away for the weekend", history: [] },
      { emit: (e) => events.push(e) },
    );
    expect(events.flatMap((e) => (e.event === 'text' ? [e.data.delta] : []))).toEqual([
      'Not safe: the garage would freeze.',
      ' Do it with 4 fixes instead?',
    ]);
    expect(turn.say).toBe('Not safe: the garage would freeze. Do it with 4 fixes instead?');
  });

  test('a model that writes nothing as it goes: the headline as the check returns, the rest at the end', async () => {
    let step = 0;
    const model: Model = {
      async next() {
        step += 1;
        return step === 1
          ? { call: { name: 'preview_plan', arguments: {} } }
          : { say: 'Not safe: the garage would freeze. Do it with 4 fixes instead?' };
      },
    };
    const events: TurnEvent[] = [];
    await runTurn(
      model,
      { callTool: async () => unsafe, resourceUriFor: () => VIEW },
      { text: 'away', history: [] },
      { emit: (e) => events.push(e) },
    );
    expect(followed(events)).toEqual([
      { step: 's1 preview_plan running' },
      { step: 's1 preview_plan done' },
      { call: 'preview_plan' },
      { text: 'Not safe: the garage would freeze. Do it with 4 fixes instead?' },
    ]);
  });

  test('a tool call that fails or answers with an error is a failed step', async () => {
    const events: TurnEvent[] = [];
    const model: Model = {
      async next(input) {
        return input.thisTurn.length === 0
          ? { call: { name: 'commit_plan', arguments: { planId: 'old' } } }
          : { say: 'That plan has changed.' };
      },
    };
    await runTurn(
      model,
      {
        callTool: async () => ({ content: [{ type: 'text', text: 'stale' }], isError: true }),
        resourceUriFor: () => undefined,
      },
      { text: 'yes', history: [] },
      { emit: (e) => events.push(e) },
    );
    expect(followed(events).slice(0, 2)).toEqual([
      { step: 's1 commit_plan running' },
      { step: 's1 commit_plan failed' },
    ]);

    const thrown: TurnEvent[] = [];
    await expect(
      runTurn(
        model,
        {
          callTool: async () => {
            throw new Error('timed out');
          },
          resourceUriFor: () => undefined,
        },
        { text: 'yes', history: [] },
        { emit: (e) => thrown.push(e) },
      ),
    ).rejects.toThrow('timed out');
    expect(followed(thrown)).toEqual([
      { step: 's1 commit_plan running' },
      { step: 's1 commit_plan failed' },
    ]);
  });
});

describe('a turn the person stops', () => {
  test('while the model writes: its stream is aborted, and no tool call starts', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const api: MessagesApi = {
      messages: {
        stream(_, options) {
          signals.push(options?.signal);
          const stopped = new Promise<never>((_, reject) =>
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          );
          stopped.catch(() => undefined);
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Let me check that. ' },
              } as Anthropic.MessageStreamEvent;
              await stopped;
            },
            finalMessage: () => stopped,
          };
        },
      },
    };
    const model = bedrockModel({ converse: anthropicConverse(api), tools: offered, home });
    let ran = 0;
    const stop = new AbortController();
    const turn = runTurn(
      model,
      {
        callTool: async () => {
          ran += 1;
          return unsafe;
        },
        resourceUriFor: () => VIEW,
      },
      { text: 'away', history: [] },
      { signal: stop.signal },
    );
    // The person taps Stop while the model is still writing.
    setTimeout(() => stop.abort(), 20);
    await expect(turn).rejects.toBeInstanceOf(TurnStoppedError);
    expect(signals[0]?.aborted).toBe(true);
    expect(ran).toBe(0);
  });

  test('during a tool call: that call finishes, and nothing more starts', async () => {
    let steps = 0;
    let ran = 0;
    const model: Model = {
      async next() {
        steps += 1;
        return { call: { name: 'commit_plan', arguments: { planId: 'p1' } } };
      },
    };
    const stop = new AbortController();
    const turn = await runTurn(
      model,
      {
        callTool: async () => {
          ran += 1;
          stop.abort();
          return committed.callTool();
        },
        resourceUriFor: () => undefined,
      },
      { text: 'yes', history: [] },
      { signal: stop.signal },
    );
    expect([steps, ran]).toEqual([1, 1]);
    expect(turn).toMatchObject({ say: 'Done: TV off.', calls: [{ name: 'commit_plan' }] });
  });

  test('stopped before it starts: the model is never asked', async () => {
    let steps = 0;
    const model: Model = {
      async next() {
        steps += 1;
        return { say: 'Hi.' };
      },
    };
    await expect(
      runTurn(model, committed, { text: 'hi', history: [] }, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(TurnStoppedError);
    expect(steps).toBe(0);
  });

  test('a model step left behind at the deadline is stopped, and its late words are never sent', async () => {
    let given: StepOptions | undefined;
    const model: Model = {
      next: (_, options) => {
        given = options;
        setTimeout(() => options?.onEvent?.({ text: 'late words' }), 40);
        return never();
      },
    };
    const events: TurnEvent[] = [];
    await expect(
      runTurn(
        model,
        committed,
        { text: 'hi', history: [] },
        { deadline: Date.now() + 10, emit: (e) => events.push(e) },
      ),
    ).rejects.toBeInstanceOf(TurnDeadlineError);
    expect(given?.signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toEqual([]);
  });
});
