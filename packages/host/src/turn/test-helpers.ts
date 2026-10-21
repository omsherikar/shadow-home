// Fakes shared by the turn's tests.
import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesApi } from './anthropic.ts';

/** A Messages API reply with these blocks. */
export const reply = (content: unknown[], stop = 'end_turn'): Anthropic.Message =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  }) as Anthropic.Message;

/** The events the API streams for a reply: each block's start, its text word by word, its stop. */
export function eventsOf(reply: Anthropic.Message): Anthropic.MessageStreamEvent[] {
  const events: Anthropic.MessageStreamEvent[] = [
    { type: 'message_start', message: { ...reply, content: [], stop_reason: null } },
  ];
  reply.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { ...block, text: '' } });
      for (const word of block.text.match(/\S+\s*/g) ?? []) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: word },
        });
      }
    } else if (block.type === 'tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    } else {
      events.push({ type: 'content_block_start', index, content_block: block });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: reply.stop_reason, stop_sequence: null, container: null },
      usage: { output_tokens: reply.usage.output_tokens },
    } as Anthropic.MessageStreamEvent,
    { type: 'message_stop' },
  );
  return events;
}

/**
 * The Messages API, streaming each answer from a list and recording what it was sent. A stream
 * whose signal aborts stops, as the SDK's does.
 */
export function fakeApi(...answers: Anthropic.Message[]) {
  const sent: Anthropic.MessageStreamParams[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const api: MessagesApi = {
    messages: {
      stream(params, options) {
        sent.push(structuredClone(params));
        signals.push(options?.signal);
        const next = answers.shift();
        const aborted = () => {
          if (options?.signal?.aborted) throw new Error('Request was aborted.');
        };
        return {
          async *[Symbol.asyncIterator]() {
            if (!next) throw new Error('No answer left');
            for (const event of eventsOf(next)) {
              aborted();
              yield event;
            }
          },
          async finalMessage() {
            aborted();
            if (!next) throw new Error('No answer left');
            return next;
          },
        };
      },
    },
  };
  return { api, sent, signals };
}

/** A streamed turn's events in order, read to its end, keep-alive comments left out. */
export async function readEvents(response: Response): Promise<{ event: string; data: unknown }[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((chunk) => chunk !== '' && !chunk.startsWith(':'))
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(chunk)?.[1] ?? 'null';
      return { event, data: JSON.parse(data) as unknown };
    });
}
