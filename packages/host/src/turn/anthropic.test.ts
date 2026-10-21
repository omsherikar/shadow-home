import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, test } from 'vitest';
import { anthropicConverse, fromReply, type MessagesApi, toRequest } from './anthropic.ts';
import { bedrockModel, type HomeBrief, toolSpecs } from './bedrock.ts';
import { eventsOf, fakeApi, reply } from './test-helpers.ts';

const home: HomeBrief = {
  now: '2027-01-15T17:45:00-06:00',
  mode: 'home',
  devices: [{ id: 'plug_tv', name: 'TV', room: 'Living room', state: { onOff: true } }],
  routines: [],
  presence: { om: 'home' },
};

const tools = [
  { name: 'preview_plan', description: 'Check a plan', inputSchema: { type: 'object' } },
  { name: 'commit_plan', description: 'Commit', inputSchema: { type: 'object' } },
];

describe('the Anthropic API behind the Converse loop', () => {
  test('a request keeps the system prompt, tools, length limit and every turn', () => {
    const input: ConverseCommandInput = {
      modelId: 'test-model',
      system: [{ text: 'You are Alexa.' }],
      messages: [
        { role: 'user', content: [{ text: 'TV off' }] },
        {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 't0', name: 'preview_plan', input: { a: 1 } } }],
        },
        {
          role: 'user',
          content: [
            { toolResult: { toolUseId: 't0', content: [{ json: { verdict: 'SAFE' } }] } },
            { text: '(On screen, a tap called approve_plan)' },
          ],
        },
        {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 't1', name: 'commit_plan', input: {} } }],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: { toolUseId: 't1', content: [{ text: 'stale' }], status: 'error' },
            },
          ],
        },
      ],
      toolConfig: { tools: toolSpecs(tools), toolChoice: { auto: {} } },
      inferenceConfig: { maxTokens: 1024, temperature: 0 },
    };
    expect(toRequest(input)).toEqual({
      model: 'test-model',
      max_tokens: 1024,
      // The current models refuse a temperature, so Converse's 0 isn't passed on.
      system: 'You are Alexa.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'TV off' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't0', name: 'preview_plan', input: { a: 1 } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't0', content: '{"verdict":"SAFE"}' },
            { type: 'text', text: '(On screen, a tap called approve_plan)' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'commit_plan', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'stale', is_error: true }],
        },
      ],
      tools: [
        { name: 'preview_plan', description: 'Check a plan', input_schema: { type: 'object' } },
        { name: 'commit_plan', description: 'Commit', input_schema: { type: 'object' } },
      ],
      tool_choice: { type: 'auto' },
    });
  });

  test('a reply keeps its words and tool calls, and drops anything else', () => {
    const out = fromReply(
      reply(
        [
          { type: 'thinking', thinking: 'hmm', signature: 's' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'preview_plan', input: { intent: 'tv off' } },
        ],
        'tool_use',
      ),
    );
    expect(out.output?.message?.content).toEqual([
      { text: 'Checking.' },
      { toolUse: { toolUseId: 'toolu_1', name: 'preview_plan', input: { intent: 'tv off' } } },
    ]);
    expect(out.stopReason).toBe('tool_use');
    expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  test('the loop runs unchanged on it: the tool the model chose, then its words', async () => {
    const { api, sent } = fakeApi(
      reply(
        [{ type: 'tool_use', id: 'toolu_1', name: 'preview_plan', input: { intent: 'tv off' } }],
        'tool_use',
      ),
      reply([{ type: 'text', text: 'Here is your log.' }]),
    );
    const model = bedrockModel({ converse: anthropicConverse(api), modelId: 'm', tools, home });
    const input = { text: 'turn off the TV', history: [], thisTurn: [] };
    expect(await model.next(input)).toEqual({
      call: { name: 'preview_plan', arguments: { intent: 'tv off' } },
    });
    expect(await model.next(input)).toEqual({ say: 'Here is your log.' });
    expect(sent[0]?.model).toBe('m');
    expect(sent[0]?.system).toContain('- plug_tv: TV (Living room)');
    expect(sent[0]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'turn off the TV' }] },
    ]);
  });

  test("it streams: the model's words as they come, and a tool call's name as its block starts", async () => {
    const order: string[] = [];
    const api: MessagesApi = {
      messages: {
        stream() {
          const message = reply(
            [
              { type: 'text', text: 'Checking.' },
              { type: 'tool_use', id: 'toolu_1', name: 'preview_plan', input: { intent: 'x' } },
            ],
            'tool_use',
          );
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of eventsOf(message)) {
                if (
                  event.type === 'content_block_delta' &&
                  event.delta.type === 'input_json_delta'
                ) {
                  order.push('input written');
                }
                yield event;
              }
            },
            finalMessage: async () => message,
          };
        },
      },
    };
    const heard: unknown[] = [];
    const out = await anthropicConverse(api)(
      { modelId: 'm', messages: [{ role: 'user', content: [{ text: 'x' }] }] },
      {
        onEvent: (e) => {
          heard.push(e);
          if ('tool' in e) order.push('tool heard');
        },
      },
    );
    expect(heard).toEqual([{ text: 'Checking.' }, { tool: 'preview_plan' }]);
    expect(order).toEqual(['tool heard', 'input written']);
    expect(out.output?.message?.content?.[1]).toEqual({
      toolUse: { toolUseId: 'toolu_1', name: 'preview_plan', input: { intent: 'x' } },
    });
  });

  test('the stop signal goes to the stream', async () => {
    const { api, signals } = fakeApi(reply([{ type: 'text', text: 'Hi.' }]));
    const stop = new AbortController();
    await anthropicConverse(api)({ modelId: 'm', messages: [] }, { signal: stop.signal });
    expect(signals[0]).toBe(stop.signal);
  });

  test('only the call that runs is announced: the first, and only when it is on offer', async () => {
    const heard = async (...content: unknown[]) => {
      const { api } = fakeApi(reply(content, 'tool_use'));
      const model = bedrockModel({ converse: anthropicConverse(api), tools, home });
      const announced: string[] = [];
      const step = await model.next(
        { text: 'x', history: [], thisTurn: [] },
        { onEvent: (e) => 'tool' in e && announced.push(e.tool) },
      );
      return { step, tools: announced };
    };
    const use = (name: string) => ({ type: 'tool_use', id: `toolu_${name}`, name, input: {} });
    expect(await heard(use('preview_plan'), use('commit_plan'))).toEqual({
      step: { call: { name: 'preview_plan', arguments: {} } },
      tools: ['preview_plan'],
    });
    expect(await heard(use('approve_plan'), use('preview_plan'))).toEqual({
      step: { say: "Sorry, I can't do that." },
      tools: [],
    });
  });
});
