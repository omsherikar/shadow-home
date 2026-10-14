// The Strands compiler end to end, with Bedrock's HTTP API answered by a stand-in: the request
// Strands builds (system prompt, the answer schema as a tool) and how it reads the answer back.
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { CompiledRule } from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { strandsCompiler } from './strands.ts';

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

describe('the Strands compiler', () => {
  test('sends the home and the answer schema to the model, and returns its answer', async () => {
    const bedrock = fakeBedrock({ rule: porch, unsupported: null });
    const compile = strandsCompiler({ modelId: 'test-model', clientConfig: bedrock.clientConfig });
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
    const compile = strandsCompiler({ modelId: 'test-model', clientConfig: bedrock.clientConfig });
    expect(await compile({ text: 'Porch light off at night', author: 'om', home })).toEqual({
      rule: porch,
      unsupported: null,
    });
    expect(bedrock.sent.length).toBeGreaterThanOrEqual(2);
  });
});
