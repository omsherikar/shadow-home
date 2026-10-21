import type { CallToolResult } from '@modelcontextprotocol/client';
import { type Step, stepLabel, type TurnEvent } from './events.ts';
import { spokenFrom } from './scripted.ts';
import type { Model, ModelEvent, ToolCall, TurnRequest, TurnResponse } from './types.ts';

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
 *
 * `emit` hears the turn as it happens (decision 107): a step for each tool call (running from
 * when the model begins it, then done or failed), each call once it returns, and the words. Words
 * go out as pieces joined with a space: each sentence of the model's once the sentence filter has
 * passed it, and, as soon as a call that speaks returns, the engine's headline (decision 108).
 * When the model answers, what's said follows on from the words sent since that headline (or
 * since the model began, with no call speaking): only the part not yet sent goes out, such as the
 * engine's question, or all of it when it doesn't follow on. When `signal` aborts, the model
 * stops writing and no further tool call starts. A model step left behind is stopped too, and
 * nothing it writes afterwards is sent.
 */
export async function runTurn(
  model: Model,
  tools: ToolRunner,
  request: TurnRequest,
  options: {
    deadline?: number;
    now?: () => number;
    signal?: AbortSignal;
    emit?: (event: TurnEvent) => void;
  } = {},
): Promise<TurnResponse> {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + TURN_DEADLINE_MS;
  const calls: ToolCall[] = [];
  const stop = new AbortController();
  const stopped = () => stop.abort();
  if (options.signal?.aborted) stop.abort();
  else options.signal?.addEventListener('abort', stopped, { once: true });
  let over = false;
  const emit = (event: TurnEvent) => {
    if (!over) options.emit?.(event);
  };
  let anySaid = false;
  // The pieces what's said will follow on from: since the last headline, or since the model began.
  let since: string[] = [];
  let headlined = false;
  const say = (piece: string) => {
    const text = piece.trim();
    if (!text) return;
    emit({ event: 'text', data: { delta: anySaid ? ` ${text}` : text } });
    anySaid = true;
    since.push(text);
  };
  let steps = 0;
  let open: Omit<Step, 'state'> | undefined;
  const begin = (tool: string) => {
    if (open) return;
    open = { id: `s${++steps}`, tool, label: stepLabel(tool) };
    emit({ event: 'step', data: { ...open, state: 'running' } });
  };
  const end = (state: 'done' | 'failed') => {
    if (!open) return;
    emit({ event: 'step', data: { ...open, state } });
    open = undefined;
  };
  const onEvent = (event: ModelEvent) => {
    if ('tool' in event) begin(event.tool);
    else say(event.text);
  };
  const finish = (words: string): TurnResponse => {
    const sent = since.join(' ');
    if (words !== sent)
      say(sent && words.startsWith(`${sent} `) ? words.slice(sent.length) : words);
    return { say: words, calls };
  };
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      // A tool call may end past the deadline (a rule compile can take 40 s): then no new model
      // step starts, since its answer would be thrown away and it costs a model call.
      if (now() >= deadline) throw new TurnDeadlineError('The turn ran out of time');
      if (stop.signal.aborted) throw new TurnStoppedError('The turn was stopped');
      if (!headlined) since = [];
      const step = await within(
        model.next({ ...request, thisTurn: calls }, { signal: stop.signal, onEvent }),
        deadline - now(),
        stop.signal,
      );
      if ('say' in step) {
        end('failed');
        return finish(step.say);
      }
      // Stopped while the model decided: its call isn't made.
      if (stop.signal.aborted) throw new TurnStoppedError('The turn was stopped');
      begin(step.call.name);
      let result: CallToolResult;
      try {
        result = await tools.callTool(step.call.name, step.call.arguments);
      } catch (e) {
        end('failed');
        throw e;
      }
      end(result.isError === true ? 'failed' : 'done');
      const resourceUri = tools.resourceUriFor(step.call.name);
      const call: ToolCall = { ...step.call, result, ...(resourceUri ? { resourceUri } : {}) };
      calls.push(call);
      emit({ event: 'call', data: { call } });
      // The engine's verdict, said as soon as it's known.
      const headline = headlineOf(result);
      if (headline) {
        since = [];
        headlined = true;
        say(headline);
      }
    }
    return finish(lastSpoken(calls) ?? UNFINISHED);
  } catch (e) {
    end('failed');
    // Nothing ran: the caller says it couldn't reach the model.
    if (calls.length === 0) throw e;
    // Something ran (a commit, perhaps) before the model failed or ran out of time: report it.
    return finish(lastSpoken(calls) ?? UNFINISHED);
  } finally {
    // A model step left behind stops writing, and nothing it writes is heard.
    over = true;
    stop.abort();
    options.signal?.removeEventListener('abort', stopped);
  }
}

const UNFINISHED = "Sorry, I couldn't finish that.";

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

function headlineOf(result: CallToolResult): string | undefined {
  const headline = (result.structuredContent as { speech?: { headline?: unknown } } | undefined)
    ?.speech?.headline;
  return typeof headline === 'string' ? headline : undefined;
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
