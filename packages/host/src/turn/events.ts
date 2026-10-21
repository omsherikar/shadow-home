import { log } from '../log.ts';
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

/** A comment line: clients ignore it, and it keeps an idle connection open through proxies. */
export const KEEP_ALIVE = ': keep-alive\n\n';
const KEEP_ALIVE_MS = 15_000;

/** Whether the client asked for the turn as a stream of events rather than one JSON answer. */
export function wantsEvents(request: Request): boolean {
  return /\btext\/event-stream\b/i.test(request.headers.get('accept') ?? '');
}

/**
 * A response that sends each event as `run` sends it, rather than when the turn ends. The headers
 * go at once with a comment; a comment every 15 s keeps the connection open while a slow tool
 * runs. `no-transform` keeps Next's compression (and any proxy) from holding events back, and
 * `X-Accel-Buffering: no` asks a proxy not to buffer. The stream ends after `done` or `error`;
 * events sent after that are dropped. `run`'s signal aborts when the client goes away (the
 * request's `signal`, or the stream being cancelled), so the turn can stop.
 */
export function eventStream(
  run: (send: (event: TurnEvent) => void, signal: AbortSignal) => Promise<void>,
  options: { signal?: AbortSignal; keepAliveMs?: number } = {},
): Response {
  const gone = new AbortController();
  const leave = () => gone.abort();
  if (options.signal?.aborted) gone.abort();
  else options.signal?.addEventListener('abort', leave, { once: true });
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    closed = true;
    clearInterval(timer);
    options.signal?.removeEventListener('abort', leave);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          finish();
        }
      };
      const close = () => {
        if (closed) return;
        finish();
        try {
          controller.close();
        } catch {
          // Already cancelled by the client.
        }
      };
      const send = (event: TurnEvent) => {
        write(encodeEvent(event));
        if (event.event === 'done' || event.event === 'error') close();
      };
      write(KEEP_ALIVE);
      timer = setInterval(() => write(KEEP_ALIVE), options.keepAliveMs ?? KEEP_ALIVE_MS);
      void run(send, gone.signal)
        .catch((e: unknown) => {
          // The error's name only: its message can carry parts of the conversation.
          log('ERROR', 'turn stream failed', { error: e instanceof Error ? e.name : 'Error' });
          send({
            event: 'error',
            data: { message: 'Sorry, something went wrong.', retryable: true },
          });
        })
        .finally(close);
    },
    cancel() {
      finish();
      gone.abort();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
