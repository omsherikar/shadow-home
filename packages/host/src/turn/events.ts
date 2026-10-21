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

const LABELS: Record<string, string> = {
  preview_plan: "Checking the plan on your home's twin",
  commit_plan: 'Making the change',
  undo: 'Finding what to put back',
  add_house_rule: 'Adding the house rule',
  get_home_state: 'Looking at your home',
  get_activity_log: 'Reading what changed',
};

/** What the screen says while a tool runs. */
export function stepLabel(tool: string): string {
  return Object.hasOwn(LABELS, tool) ? (LABELS[tool] as string) : 'Working on it';
}

/** An event as Server-Sent Events text: its type, and its data as one line of JSON. */
export function encodeEvent({ event, data }: TurnEvent): string {
  // JSON.stringify escapes line breaks inside strings, so the data stays on one line.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
