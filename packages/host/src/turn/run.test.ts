import { afterEach, describe, expect, test } from 'vitest';
import { runTurn, TurnDeadlineError, TurnStoppedError, within } from './run.ts';
import type { Model } from './types.ts';

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

describe('a turn the person stops', () => {
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
});
