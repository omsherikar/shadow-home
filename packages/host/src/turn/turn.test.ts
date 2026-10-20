import { describe, expect, test } from 'vitest';
import type { HomeBrief } from './bedrock.ts';
import type { Tools } from './mcp.ts';
import { takeTurn } from './turn.ts';

const APOLOGY = "Sorry, I can't reach my assistant model right now.";
const never = () => new Promise<never>(() => {});
const home: HomeBrief = {
  now: '2027-01-15T17:45:00-06:00',
  mode: 'home',
  devices: [],
  routines: [],
  presence: {},
};
let closed = 0;
const tools: Tools = {
  callTool: async () => ({ content: [] }),
  resourceUriFor: () => undefined,
  modelTools: [],
  homeBrief: async () => home,
  close: async () => {
    closed += 1;
  },
};
const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe('a whole turn shares one deadline', () => {
  test('a server that never answers while setting up: the person hears the apology in time', async () => {
    const started = Date.now();
    const { turn, failure } = await takeTurn(
      { text: 'TV off', history: [] },
      { connect: never, model: never, deadline: started + 50 },
    );
    expect(turn).toEqual({ say: APOLOGY, calls: [], error: 'TurnDeadlineError' });
    expect(failure).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('time spent setting up comes out of what the model has', async () => {
    const started = Date.now();
    const { turn } = await takeTurn(
      { text: 'TV off', history: [] },
      {
        connect: () => after(60, tools),
        model: async () => ({ next: never }),
        deadline: started + 100,
      },
    );
    expect(turn.say).toBe(APOLOGY);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a turn in time is answered, and the connection is closed either way', async () => {
    closed = 0;
    const { turn, failure } = await takeTurn(
      { text: 'Hello', history: [] },
      {
        connect: async () => tools,
        model: async () => ({ next: async () => ({ say: 'Hi.' }) }),
        deadline: Date.now() + 1_000,
      },
    );
    expect(turn).toEqual({ say: 'Hi.', calls: [] });
    expect(failure).toBeUndefined();
    expect(closed).toBe(1);
  });
});
