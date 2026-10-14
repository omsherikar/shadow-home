import type { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, test } from 'vitest';
import { demoSteps } from '../demo/steps.ts';
import { bedrockModel, conversation, type HomeBrief, systemPrompt, toolSpecs } from './bedrock.ts';
import { visibleToModel } from './mcp.ts';
import { devicesNamed } from './scripted.ts';
import type { ModelInput, ToolCall } from './types.ts';

const home: HomeBrief = {
  now: '2027-01-15T17:45:00-06:00',
  mode: 'home',
  devices: [
    {
      id: 'thermostat_main',
      name: 'Main thermostat',
      room: 'Living room',
      state: { heatingSetpointC: 20 },
    },
    { id: 'plug_tv', name: 'TV', room: 'Living room', state: { onOff: true } },
  ],
  routines: [{ id: 'coffee_at_7', name: 'Coffee at 7', at: '07:00' }],
  presence: { om: 'home' },
};

const tools = [
  {
    name: 'preview_plan',
    description: 'Check a plan',
    inputSchema: { $schema: 'x', type: 'object' },
  },
  { name: 'commit_plan', description: 'Commit', inputSchema: { type: 'object' } },
];

/** A Converse stand-in that answers from a list and records what it was sent. */
function fakeConverse(...answers: unknown[]) {
  const sent: ConverseCommandInput[] = [];
  const converse = async (input: ConverseCommandInput) => {
    sent.push(structuredClone(input));
    return { output: answers.shift() } as ConverseCommandOutput;
  };
  return { converse, sent };
}

const toolUse = (name: string, input: Record<string, unknown>) => ({
  message: { role: 'assistant' as const, content: [{ toolUse: { toolUseId: 'x', name, input } }] },
});
const text = (t: string) => ({ message: { role: 'assistant' as const, content: [{ text: t }] } });

const previewCall: ToolCall = {
  name: 'preview_plan',
  arguments: { intent: 'tv off', actions: [] },
  result: {
    content: [{ type: 'text', text: 'SAFE (T0): Safe: TV off.' }],
    structuredContent: {
      planId: 'p1',
      verdict: 'SAFE',
      tier: 'T0',
      speech: { headline: 'Safe: TV off.' },
    },
  },
};

const input = (over: Partial<ModelInput> = {}): ModelInput => ({
  text: 'Turn off the TV',
  history: [],
  thisTurn: [],
  ...over,
});

describe('the Bedrock model', () => {
  test('asks for the tool the model chose', async () => {
    const { converse, sent } = fakeConverse(toolUse('preview_plan', { intent: 'tv off' }));
    const model = bedrockModel({ converse, tools, home });
    expect(await model.next(input())).toEqual({
      call: { name: 'preview_plan', arguments: { intent: 'tv off' } },
    });
    expect(sent[0]?.toolConfig?.tools?.map((t) => t.toolSpec?.name)).toEqual([
      'preview_plan',
      'commit_plan',
    ]);
    expect(sent[0]?.inferenceConfig?.temperature).toBe(0);
  });

  test('a tool it was not offered is refused, whatever it asks for', async () => {
    const { converse } = fakeConverse(toolUse('approve_plan', { planId: 'p1' }));
    const model = bedrockModel({ converse, tools, home });
    expect(await model.next(input())).toEqual({ say: "Sorry, I can't do that." });
  });

  test('once a tool has spoken, the reply is the server’s speech, not the model’s words', async () => {
    const { converse } = fakeConverse(text('All done, your TV is off and everything is great!'));
    const model = bedrockModel({ converse, tools, home });
    expect(await model.next(input({ thisTurn: [previewCall] }))).toEqual({ say: 'Safe: TV off.' });
  });

  test('without speech from a tool, its own words', async () => {
    const { converse } = fakeConverse(text('Your home is in home mode.'));
    const model = bedrockModel({ converse, tools, home });
    expect(await model.next(input())).toEqual({ say: 'Your home is in home mode.' });
  });
});

describe('the conversation it sees', () => {
  test('alternates person and assistant, with each tool result after its call', () => {
    const messages = conversation(
      input({
        history: [
          { name: 'heard', arguments: { text: 'Turn off the TV' } },
          {
            name: 'preview_plan',
            arguments: { intent: 'tv off' },
            structuredContent: { planId: 'p1', tier: 'T0', diff: [{ big: 'row' }], timeline: [] },
          },
          { name: 'said', arguments: { text: 'Safe: TV off.' } },
          { name: 'closed', arguments: {} },
        ],
        text: 'Yes',
        thisTurn: [previewCall],
      }),
    );
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    const first = messages[1]?.content?.[0]?.toolUse;
    const result = messages[2]?.content?.[0]?.toolResult;
    expect(result?.toolUseId).toBe(first?.toolUseId);
    // An earlier result keeps IDs and the verdict, not the whole diff.
    expect(result?.content?.[0]?.json).toEqual({ planId: 'p1', tier: 'T0' });
    // A closed question and the next words arrive as one person turn.
    expect(messages[4]?.content?.map((c) => c.text)).toEqual([
      '(On screen, the person closed the question without a yes.)',
      'Yes',
    ]);
    // This turn's result is whole.
    expect(messages[6]?.content?.[0]?.toolResult?.content?.[0]?.json).toEqual(
      previewCall.result.structuredContent,
    );
  });

  test('a tap on screen is told to the model, not replayed as its own call', () => {
    const messages = conversation(
      input({
        history: [
          {
            name: 'commit_plan',
            arguments: { planId: 'p1' },
            structuredContent: { status: 'committed', speech: { headline: 'Done: TV off.' } },
            by: 'screen',
          },
        ],
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content?.[0]?.text).toBe(
      '(On screen, a tap called commit_plan: committed, Done: TV off.)',
    );
  });

  test('tools keep their JSON Schema, without the $schema marker', () => {
    expect(toolSpecs(tools)[0]?.toolSpec?.inputSchema).toEqual({ json: { type: 'object' } });
  });

  test('the app-only approve_plan is never offered to a model', () => {
    expect(visibleToModel({ ui: { visibility: ['app'] } })).toBe(false);
    expect(visibleToModel({ ui: { resourceUri: 'ui://x' } })).toBe(true);
    expect(visibleToModel(undefined)).toBe(true);
  });

  test('the system prompt lists the device IDs and the time zone to write times in', () => {
    const prompt = systemPrompt(home);
    expect(prompt).toContain('- thermostat_main: Main thermostat (Living room); heatingSetpointC');
    expect(prompt).toContain('offset -06:00');
    expect(prompt).toContain('Pass confirmed: true only when their last words were a yes');
  });
});

describe('the demo', () => {
  test('every line in order, each beat followed by the answer the person gives', () => {
    const steps = demoSteps([
      { id: 'weekend_away', say: 'Away for the weekend.' },
      { id: 'what_changed_and_undo', say: ['What changed?', 'Undo the thermostat.'] },
    ]);
    expect(steps.map((s) => s.line)).toEqual([
      'Away for the weekend.',
      'Yes.',
      'What changed?',
      'Undo the thermostat.',
      'Yes.',
    ]);
  });

  test('"the thermostat" is the one whose name says it with the fewest other words', () => {
    const names = {
      devices: {
        thermostat_main: { name: 'Main thermostat', room: 'Living room' },
        garage_thermostat: { name: 'Garage heater thermostat', room: 'Garage' },
      },
      routines: {},
      members: {},
    };
    expect(devicesNamed('thermostat', names)).toEqual(['thermostat_main']);
  });
});
