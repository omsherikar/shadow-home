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
