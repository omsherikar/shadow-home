// The Strands compiler end to end, with each provider's HTTP API answered by a stand-in: the
// request Strands builds (system prompt, the answer schema as a tool) and how it reads the answer
// back.
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { CompiledRule } from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { COMPILER_MODELS, strandsCompiler, strandsCompilers } from './strands.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));

const porch: CompiledRule = {
  template: 'never_when',
  priority: 'comfort',
  params: {
    x: { device: 'light_porch', attr: 'onOff', eq: true },
    when: { time: { from: '23:00', to: '06:00' } },
  },
};

interface Sent {
  path: string;
  body: {
    system?: { text?: string }[];
    messages: { role: string; content: Record<string, unknown>[] }[];
    toolConfig?: {
      tools: { toolSpec: { name: string; inputSchema: { json: Record<string, unknown> } } }[];
    };
  };
}

/** Bedrock's Converse API, answering each call with the next tool input (or text) in the list. */
function fakeBedrock(...replies: unknown[]) {
  const sent: Sent[] = [];
  const requestHandler = {
    handle: async (request: { path: string; body: string }) => {
      const body = JSON.parse(request.body) as Sent['body'];
      sent.push({ path: decodeURIComponent(request.path), body });
      const tool = body.toolConfig?.tools[0]?.toolSpec.name;
      const reply = replies.shift();
      const content =
        reply === undefined
          ? [{ text: 'Done.' }]
          : [{ toolUse: { toolUseId: `t${sent.length}`, name: tool, input: reply } }];
      const json = JSON.stringify({
        output: { message: { role: 'assistant', content } },
        stopReason: reply === undefined ? 'end_turn' : 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metrics: { latencyMs: 1 },
      });
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: Readable.from([Buffer.from(json)]),
        },
      };
    },
  };
  return {
    sent,
    clientConfig: {
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: requestHandler as never,
    },
  };
}

describe('the Strands compiler on Bedrock', () => {
  test('sends the home and the answer schema to the model, and returns its answer', async () => {
    const bedrock = fakeBedrock({ rule: porch, unsupported: null });
    const compile = strandsCompiler({
      modelId: 'test-model',
      provider: 'bedrock',
      clientConfig: bedrock.clientConfig,
    });
    const answer = await compile({ text: 'Porch light off at night', author: 'maya', home });
    expect(answer).toEqual({ rule: porch, unsupported: null });

    const first = bedrock.sent[0];
    expect(first?.path).toContain('/model/test-model/converse');
    expect(first?.body.system?.[0]?.text).toContain('- light_porch: Porch light (');
    expect(JSON.stringify(first?.body.messages[0])).toContain(
      'Maya says: \\"Porch light off at night\\"',
    );
    // The answer schema reaches Bedrock as a tool whose input is an object of the two fields.
    const schema = first?.body.toolConfig?.tools[0]?.toolSpec.inputSchema.json;
    expect(schema?.type).toBe('object');
    expect(Object.keys(schema?.properties as object)).toEqual(['rule', 'unsupported']);
  });

  test('an answer that doesn’t fit the schema is sent back with the error, and the retry counts', async () => {
    const bedrock = fakeBedrock(
      { rule: { template: 'sometimes' }, unsupported: null },
      { rule: porch, unsupported: null },
    );
    const compile = strandsCompiler({
      modelId: 'test-model',
      provider: 'bedrock',
      clientConfig: bedrock.clientConfig,
    });
    expect(await compile({ text: 'Porch light off at night', author: 'om', home })).toEqual({
      rule: porch,
      unsupported: null,
    });
    expect(bedrock.sent.length).toBeGreaterThanOrEqual(2);
  });
});

interface SentToAnthropic {
  url: string;
  headers: Headers;
  body: {
    model: string;
    temperature?: number;
    system?: string | { text: string }[];
    messages: { role: string; content: unknown }[];
    tools?: { name: string; input_schema: Record<string, unknown> }[];
    stream?: boolean;
  };
}

/**
 * The Anthropic Messages API, streaming like the real one: each call answers with the next tool
 * input in the list as a tool_use block, or with text once the list is used up.
 */
function fakeAnthropic(...replies: unknown[]) {
  const sent: SentToAnthropic[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as SentToAnthropic['body'];
    sent.push({ url: String(url), headers: new Headers(init?.headers), body });
    const reply = replies.shift();
    const tool = body.tools?.[0]?.name;
    const events: [string, unknown][] = [
      [
        'message_start',
        {
          message: {
            id: `msg_${sent.length}`,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ],
      ...(reply === undefined
        ? ([
            ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } }],
          ] as [string, unknown][])
        : ([
            [
              'content_block_start',
              {
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: `toolu_${sent.length}`,
                  name: tool,
                  input: {},
                },
              },
            ],
            [
              'content_block_delta',
              {
                index: 0,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply) },
              },
            ],
          ] as [string, unknown][])),
      ['content_block_stop', { index: 0 }],
      [
        'message_delta',
        {
          delta: {
            stop_reason: reply === undefined ? 'end_turn' : 'tool_use',
            stop_sequence: null,
          },
          usage: { output_tokens: 1 },
        },
      ],
      ['message_stop', {}],
    ];
    const sse = events
      .map(
        ([type, data]) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`,
      )
      .join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { sent, anthropicConfig: { apiKey: 'test-key', fetch: fetch as typeof globalThis.fetch } };
}

describe('the Strands compiler on the Anthropic API', () => {
  test('sends the home and the answer schema to the model, and returns its answer', async () => {
    const anthropic = fakeAnthropic({ rule: porch, unsupported: null });
    const compile = strandsCompiler({
      modelId: 'test-model',
      anthropicConfig: anthropic.anthropicConfig,
    });
    const answer = await compile({ text: 'Porch light off at night', author: 'maya', home });
    expect(answer).toEqual({ rule: porch, unsupported: null });

    const first = anthropic.sent[0];
    expect(first?.url).toContain('/v1/messages');
    expect(first?.headers.get('x-api-key')).toBe('test-key');
    expect(first?.body.model).toBe('test-model');
    // The current models refuse a temperature; Bedrock's compilers still send 0.
    expect(first?.body.temperature).toBeUndefined();
    expect(JSON.stringify(first?.body.system)).toContain('- light_porch: Porch light (');
    expect(JSON.stringify(first?.body.messages[0])).toContain(
      'Maya says: \\"Porch light off at night\\"',
    );
    // The answer schema reaches the API as a tool whose input is an object of the two fields.
    const schema = first?.body.tools?.[0]?.input_schema;
    expect(schema?.type).toBe('object');
    expect(Object.keys(schema?.properties as object)).toEqual(['rule', 'unsupported']);
  });

  test('an answer that doesn’t fit the schema is sent back with the error, and the retry counts', async () => {
    const anthropic = fakeAnthropic(
      { rule: { template: 'sometimes' }, unsupported: null },
      { rule: porch, unsupported: null },
    );
    const compile = strandsCompiler({
      modelId: 'test-model',
      anthropicConfig: anthropic.anthropicConfig,
    });
    expect(await compile({ text: 'Porch light off at night', author: 'om', home })).toEqual({
      rule: porch,
      unsupported: null,
    });
    expect(anthropic.sent.length).toBeGreaterThanOrEqual(2);
  });

  test('three different models by default, on the Anthropic API unless Bedrock is asked for', () => {
    expect(new Set(COMPILER_MODELS.anthropic).size).toBe(3);
    expect(new Set(COMPILER_MODELS.bedrock).size).toBe(3);
    expect(strandsCompilers(undefined, { anthropicConfig: { apiKey: 'k' } })).toHaveLength(3);
    expect(strandsCompilers(['one'], { anthropicConfig: { apiKey: 'k' } })).toHaveLength(1);
  });
});
