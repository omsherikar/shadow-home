/**
 * The browser's side of a turn. Asked for a stream, /api/turn sends what happens as it happens:
 * steps (a tool call starting, then done or failed), Alexa's words as they're written, each finished
 * tool call, then `done` with what to show and say, or `error`. A server that answers with JSON
 * (one that doesn't stream yet) gives one `done`. Everything that arrives is checked with zod.
 */
import { z } from 'zod';
import type { ToolCall, TurnResponse } from '../turn/types.ts';

export type StepState = 'running' | 'done' | 'failed';

export type TurnEvent =
  | { type: 'step'; id: string; tool: string; label: string; state: StepState }
  | { type: 'text'; delta: string }
  | { type: 'call'; call: ToolCall }
  | { type: 'done'; turn: TurnResponse }
  | {
      type: 'error';
      message: string;
      retryable: boolean;
      /** For a limit: how long until a turn can go through again. */
      retryAfterMs?: number;
    };

const toolCall = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  // The tool's result as the server returned it; the page reads its parts with their own checks.
  result: z.looseObject({
    content: z.array(z.looseObject({ type: z.string() })).optional(),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  }),
  resourceUri: z.string().optional(),
});

const turnResponse = z.object({ say: z.string(), calls: z.array(toolCall) });

const schemas = {
  step: z.object({
    id: z.string(),
    tool: z.string(),
    label: z.string(),
    state: z.enum(['running', 'done', 'failed']),
  }),
  text: z.object({ delta: z.string() }),
  call: z.object({ call: toolCall }),
  done: turnResponse,
  error: z.object({
    message: z.string(),
    retryable: z.boolean(),
    retryAfterMs: z.number().nonnegative().optional(),
  }),
};

/**
 * One event from its type and its data, or null when it isn't one this page knows or its data
 * isn't what that type carries. An unknown type is skipped, so the server can add more.
 */
export function eventFrom(type: string, data: string): TurnEvent | null {
  if (!Object.hasOwn(schemas, type)) return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  switch (type) {
    case 'step': {
      const r = schemas.step.safeParse(json);
      return r.success ? { type, ...r.data } : null;
    }
    case 'text': {
      const r = schemas.text.safeParse(json);
      return r.success ? { type, delta: r.data.delta } : null;
    }
    case 'call': {
      const r = schemas.call.safeParse(json);
      return r.success ? { type, call: r.data.call as ToolCall } : null;
    }
    case 'done': {
      const r = schemas.done.safeParse(json);
      return r.success ? { type, turn: r.data as TurnResponse } : null;
    }
    case 'error': {
      const r = schemas.error.safeParse(json);
      return r.success ? { type, ...r.data } : null;
    }
    default:
      return null;
  }
}

/**
 * Reads an event stream as it arrives, in chunks cut anywhere. `push` returns the events each chunk
 * completed; an event is complete at the blank line after it. Lines starting with `:` are
 * keep-alives. Line ends may be `\n`, `\r\n` or `\r`. `last` says the stream has ended; whatever
 * is left unfinished then is dropped, as the event stream format says.
 */
export function eventParser(): { push(chunk: string, last?: boolean): TurnEvent[] } {
  let buffer = '';
  let type = '';
  let data: string[] = [];
  return {
    push(chunk, last = false) {
      buffer += chunk;
      // A `\r` at the very end may be the first half of a `\r\n` still on its way.
      const held = !last && buffer.endsWith('\r') ? '\r' : '';
      const lines = buffer.slice(0, buffer.length - held.length).split(/\r\n|\r|\n/);
      buffer = (lines.pop() ?? '') + held;
      const events: TurnEvent[] = [];
      for (const line of lines) {
        if (line === '') {
          const event = type && data.length > 0 ? eventFrom(type, data.join('\n')) : null;
          if (event) events.push(event);
          type = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const raw = colon === -1 ? '' : line.slice(colon + 1);
        const value = raw.startsWith(' ') ? raw.slice(1) : raw;
        if (field === 'event') type = value;
        else if (field === 'data') data.push(value);
      }
      return events;
    },
  };
}

/** What to say when the turn route refuses before it starts. */
export function refusal(status: number, retryAfter?: string | null): TurnEvent {
  if (status === 400) {
    return {
      type: 'error',
      message: "I couldn't take that request. Try saying it a shorter or simpler way.",
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      type: 'error',
      message: 'This page lost its connection to Alexa. Reload the page, then try again.',
      retryable: false,
    };
  }
  if (status === 429) {
    const seconds = Number(retryAfter);
    return {
      type: 'error',
      message: "I've had a lot of requests. Try again in a little while.",
      retryable: true,
      ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {}),
    };
  }
  return { type: 'error', message: 'Something went wrong on my side. Try again.', retryable: true };
}
