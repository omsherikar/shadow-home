import type { CallToolResult } from '@modelcontextprotocol/client';
import { spokenFrom } from './scripted.ts';
import type { Model, ToolCall, TurnRequest, TurnResponse } from './types.ts';

/** The MCP side of a turn: call a tool, and say which view (if any) it declares. */
export interface ToolRunner {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  resourceUriFor(name: string): string | undefined;
}

const MAX_STEPS = 6;
/**
 * How long a turn waits, from when it starts: setting up (connecting, the home) and the model's
 * steps together. Each model call gives up after 20 s with one retry (anthropic.ts), and a turn
 * may take six steps, so without this a person could wait minutes.
 */
export const TURN_DEADLINE_MS = 30_000;

/** The model didn't decide in time; nothing it decides afterwards is acted on. */
export class TurnDeadlineError extends Error {
  override name = 'TurnDeadlineError';
}

/** The person stopped the turn (the client went away): nothing more is started. */
export class TurnStoppedError extends Error {
  override name = 'TurnStoppedError';
}

/**
 * One conversational turn: the model picks tool calls until it has something to say. The model's
 * steps share the turn's deadline (ms since the epoch); a step still thinking when it passes is
 * left behind, and since only a step's answer leads to a tool call, nothing runs from it. A tool
 * call already started finishes (it has its own timeout in mcp.ts), so the person hears what
 * really happened.
 */
export async function runTurn(
  model: Model,
  tools: ToolRunner,
  request: TurnRequest,
  options: { deadline?: number; now?: () => number } = {},
): Promise<TurnResponse> {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + TURN_DEADLINE_MS;
  const calls: ToolCall[] = [];
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      // A tool call may end past the deadline (a rule compile can take 40 s): then no new model
      // step starts, since its answer would be thrown away and it costs a model call.
      if (now() >= deadline) throw new TurnDeadlineError('The turn ran out of time');
      const step = await within(model.next({ ...request, thisTurn: calls }), deadline - now());
      if ('say' in step) return { say: step.say, calls };
      const result = await tools.callTool(step.call.name, step.call.arguments);
      const resourceUri = tools.resourceUriFor(step.call.name);
      calls.push({ ...step.call, result, ...(resourceUri ? { resourceUri } : {}) });
    }
  } catch (e) {
    // Nothing ran: the caller says it couldn't reach the model.
    if (calls.length === 0) throw e;
    // Something ran (a commit, perhaps) before the model failed or ran out of time: report it.
  }
  return { say: lastSpoken(calls) ?? "Sorry, I couldn't finish that.", calls };
}

/**
 * The promise, or a TurnDeadlineError after `ms`, or a TurnStoppedError when `signal` aborts. The
 * promise itself runs on; if it fails after being left behind, that's not an unhandled rejection,
 * which would be logged with its message.
 */
export function within<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  promise.catch(() => undefined);
  if (signal?.aborted) return Promise.reject(new TurnStoppedError('The turn was stopped'));
  if (ms <= 0) return Promise.reject(new TurnDeadlineError('The turn ran out of time'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: (() => void) | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnDeadlineError('The turn ran out of time')), ms);
    stopped = () => reject(new TurnStoppedError('The turn was stopped'));
    signal?.addEventListener('abort', stopped, { once: true });
  });
  return Promise.race([promise, late]).finally(() => {
    clearTimeout(timer);
    if (stopped) signal?.removeEventListener('abort', stopped);
  });
}

function lastSpoken(calls: ToolCall[]): string | undefined {
  const spoke = calls.findLast(
    (c) => (c.result.structuredContent as { speech?: unknown } | undefined)?.speech,
  );
  if (!spoke) return undefined;
  return spokenFrom(
    spoke.result.structuredContent as Record<string, unknown>,
    spoke.result.content,
  );
}
