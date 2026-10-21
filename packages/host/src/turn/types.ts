import type { CallToolResult } from '@modelcontextprotocol/client';

/** Display names the server sends with plan-view results, keyed by ID. */
export interface Names {
  devices: Record<string, { name: string; room: string }>;
  routines: Record<string, string>;
  members: Record<string, string>;
}

/** One tool call the assistant made this turn, with what came back. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result: CallToolResult;
  /** The MCP App view the tool declares, if any. */
  resourceUri?: string;
}

/**
 * What the browser keeps of the conversation and sends back each turn: tool calls without view
 * metadata, plus `heard` (what the person said), `said` (what the assistant said) and `closed`
 * (a tap that changed nothing).
 */
export interface Remembered {
  name: string;
  arguments: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  /** Set when a tap on screen made the call, not the assistant. */
  by?: 'screen';
}

export interface TurnRequest {
  text: string;
  history: Remembered[];
  names?: Names;
  /** What a view on screen last told the assistant (a tap), for its next turn. */
  screen?: string;
}

export interface TurnResponse {
  /** What the assistant says, built from the server's speech fields. */
  say: string;
  calls: ToolCall[];
}

export type ModelStep =
  | { call: { name: string; arguments: Record<string, unknown> } }
  | { say: string };

export interface ModelInput extends TurnRequest {
  /** Calls already made this turn, in order. */
  thisTurn: ToolCall[];
}

/** What a model reports as it writes, when it can: its words, and the tool it has begun to call. */
export type ModelEvent = { text: string } | { tool: string };

export interface StepOptions {
  /** Aborted when the person stops the turn or it runs out of time: the model stops writing. */
  signal?: AbortSignal;
  /** Told of the model's words and tool calls as they come. */
  onEvent?: (event: ModelEvent) => void;
}

/** Whatever decides the next step of a turn: the scripted stand-in, or a live model. */
export interface Model {
  next(input: ModelInput): Promise<ModelStep>;
}
