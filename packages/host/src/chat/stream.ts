/**
 * The browser's side of a turn. Asked for a stream, /api/turn sends what happens as it happens:
 * steps (a tool call starting, then done or failed), Alexa's words as they're written, each finished
 * tool call, then `done` with what to show and say, or `error`. A server that answers with JSON
 * (one that doesn't stream yet) gives one `done`. Everything that arrives is checked with zod.
 */
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
