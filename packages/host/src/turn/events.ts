import type { ToolCall, TurnResponse } from './types.ts';

/** A tool call as the screen shows it while it runs; the same `id` comes again with its new state. */
export interface Step {
  id: string;
  tool: string;
  /** Plain words for what the tool does, from a fixed list: never the model's words. */
  label: string;
  state: 'running' | 'done' | 'failed';
}

/** Why a turn ended without an answer, in words a person can read. */
export interface TurnError {
  message: string;
  retryable: boolean;
  /** For a limit: how long until a turn would be taken again. */
  retryAfterMs?: number;
}

/**
 * One event of a streamed turn (decision 107): steps, the model's words and each finished tool
 * call as they happen, then `done` with the whole turn, or `error`. Either of those is last.
 */
export type TurnEvent =
  | { event: 'step'; data: Step }
  | { event: 'text'; data: { delta: string } }
  | { event: 'call'; data: { call: ToolCall } }
  | { event: 'done'; data: TurnResponse }
  | { event: 'error'; data: TurnError };
