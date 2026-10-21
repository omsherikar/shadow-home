import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  Message,
  ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { Converse } from './bedrock.ts';

/** The voice loop's model on the Anthropic API: a quick one, since a person waits on every step. */
export const ANTHROPIC_MODEL_ID = 'claude-haiku-5-5';

/** What the loop reads of a message stream: its events as they come, then the whole message. */
export interface ModelStream extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/**
 * For the voice loop's own model: no thinking, at the lowest effort. A person waits on every step,
 * the steps are small (pick a tool, explain a result in a sentence or two), and Claude Haiku 5.5
 * thinks by default. It accepts thinking turned off at effort low, medium or high; low is the
 * least. Another model (ANTHROPIC_MODEL_ID) gets the API's defaults, since not every model takes
 * these (Claude Sonnet 5.5 refuses thinking off).
 */
const QUICK = {
  thinking: { type: 'disabled' as const },
  output_config: { effort: 'low' as const },
};

/** The one call the loop makes, so tests can stand in for the API. */
export interface MessagesApi {
  messages: {
    stream(params: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }): ModelStream;
  };
}

let client: Anthropic | undefined;

/**
 * Converse calls answered by the Anthropic API. The loop in bedrock.ts speaks Converse; this
 * translates each request and reply, so the loop, the history it keeps and its tests stay as they
 * are. Each call streams (the SDK's `messages.stream`): the model's words go to `onEvent` as they
 * come, and so does each tool call as its block starts, by name, before its input is written.
 * `signal` aborts the stream. The key comes from ANTHROPIC_API_KEY.
 */
export function anthropicConverse(api?: MessagesApi): Converse {
  const messages = api ?? sharedClient();
  return async (input, options = {}) => {
    const stream = messages.messages.stream(
      toRequest(input),
      options.signal ? { signal: options.signal } : undefined,
    );
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        options.onEvent?.({ tool: event.content_block.name });
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        options.onEvent?.({ text: event.delta.text });
      }
    }
    return fromReply(await stream.finalMessage());
  };
}

function sharedClient(): Anthropic {
  // One try and one retry, each short: a person is waiting, and the turn says sorry if both fail.
  // For a stream the timeout covers the wait for it to start; the turn's deadline covers the rest.
  if (!client) client = new Anthropic({ timeout: 20_000, maxRetries: 1 });
  return client;
}

/** A Converse request as a Messages API request. */
export function toRequest(input: ConverseCommandInput): Anthropic.MessageStreamParams {
  const system = (input.system ?? [])
    .map((s) => s.text ?? '')
    .filter(Boolean)
    .join('\n\n');
  const tools: Anthropic.Tool[] = (input.toolConfig?.tools ?? []).flatMap((t) =>
    t.toolSpec?.name
      ? [
          {
            name: t.toolSpec.name,
            ...(t.toolSpec.description ? { description: t.toolSpec.description } : {}),
            input_schema: t.toolSpec.inputSchema?.json as Anthropic.Tool.InputSchema,
          },
        ]
      : [],
  );
  const choice = input.toolConfig?.toolChoice;
  const model = input.modelId ?? ANTHROPIC_MODEL_ID;
  return {
    model,
    max_tokens: input.inferenceConfig?.maxTokens ?? 1024,
    // No temperature: the current Claude models refuse it (deprecated) and pick their own.
    ...(model === ANTHROPIC_MODEL_ID ? QUICK : {}),
    ...(system ? { system } : {}),
    messages: (input.messages ?? []).map(toMessage),
    ...(tools.length === 0
      ? {}
      : {
          tools,
          tool_choice: choice?.tool?.name
            ? { type: 'tool' as const, name: choice.tool.name }
            : { type: choice?.any ? ('any' as const) : ('auto' as const) },
        }),
  };
}

function toMessage(m: Message): Anthropic.MessageParam {
  return {
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: (m.content ?? []).map(toBlock),
  };
}

function toBlock(b: ContentBlock): Anthropic.ContentBlockParam {
  if (b.text !== undefined) return { type: 'text', text: b.text };
  if (b.toolUse) {
    return {
      type: 'tool_use',
      id: b.toolUse.toolUseId ?? '',
      name: b.toolUse.name ?? '',
      input: b.toolUse.input ?? {},
    };
  }
  if (b.toolResult) {
    return {
      type: 'tool_result',
      tool_use_id: b.toolResult.toolUseId ?? '',
      content: resultText(b.toolResult.content),
      ...(b.toolResult.status === 'error' ? { is_error: true } : {}),
    };
  }
  throw new Error(`No Messages API form for a ${Object.keys(b).join('/')} block`);
}

/** A tool result as text: its JSON as written, its text as is. */
function resultText(content: ToolResultContentBlock[] | undefined): string {
  return (content ?? [])
    .map((c) => (c.json !== undefined ? JSON.stringify(c.json) : (c.text ?? '')))
    .join('\n');
}

/** A Messages API reply as a Converse reply: its words and tool calls, nothing else. */
export function fromReply(reply: Anthropic.Message): ConverseCommandOutput {
  const content: ContentBlock[] = reply.content.flatMap((b): ContentBlock[] => {
    if (b.type === 'text') return [{ text: b.text }];
    if (b.type === 'tool_use') {
      return [{ toolUse: { toolUseId: b.id, name: b.name, input: b.input as never } }];
    }
    return [];
  });
  const { input_tokens: inputTokens, output_tokens: outputTokens } = reply.usage;
  return {
    $metadata: {},
    output: { message: { role: 'assistant', content } },
    stopReason: (reply.stop_reason ?? 'end_turn') as ConverseCommandOutput['stopReason'],
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    metrics: { latencyMs: 0 },
  };
}
