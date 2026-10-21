import { log } from '../log.ts';
import { fromOtherSite, OTHER_SITE } from '../origin.ts';
import { visitorOf } from '../visitor.ts';
import { eventStream, type TurnEvent, wantsEvents } from './events.ts';
import { turnRequest } from './request.ts';
import { TURN_DEADLINE_MS } from './run.ts';
import type { TurnRequest, TurnResponse } from './types.ts';

/** What the person hears when the hour's live turns are used up, without the stream's retry time. */
export const LIMITED = "I've had a lot of requests this hour.";

/** What /api/turn needs from its surroundings; the route builds it from the environment. */
export interface TurnRoute {
  /** The scripted model answers (MOCK_MODEL, DEMO_MODE): no model calls, so no limit. */
  scripted: boolean;
  /** The hourly caps on live turns (limit.ts), and how long until a visitor may take another. */
  limit: ((visitor: string) => 'ok' | 'visitor' | 'instance') & {
    retryAfter(visitor: string): number;
  };
  /** One whole turn (takeTurn), told of each event as it happens. */
  take(
    input: TurnRequest,
    options: { deadline: number; signal?: AbortSignal; emit?: (event: TurnEvent) => void },
  ): Promise<{ turn: TurnResponse & { error?: string }; failure?: unknown }>;
}

/**
 * One conversational turn over HTTP. A request from another site (403) and a bad request (400)
 * are refused as plain HTTP. With `Accept: text/event-stream` the turn streams as it happens
 * (decision 107): steps, words and calls, then `done` with the whole turn, or `error` when it
 * failed with nothing done or the hour's live turns are used up (with when to try again). Without
 * that header the answer is the whole turn as JSON, as before, so an older page keeps working.
 * When a streaming client goes away, the turn stops: the model stops writing and no further tool
 * call starts.
 */
export async function respondToTurn(request: Request, route: TurnRoute): Promise<Response> {
  if (fromOtherSite(request)) return OTHER_SITE();
  const started = Date.now();
  const { headers } = request;
  const parsed = turnRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad turn request' }, { status: 400 });
  const input = parsed.data as TurnRequest;
  const streamed = wantsEvents(request);
  const { scripted } = route;
  if (!scripted) {
    const visitor = visitorOf(request);
    if (route.limit(visitor) !== 'ok') {
      if (!streamed) return Response.json({ say: `${LIMITED} Try again later.`, calls: [] });
      const wait = route.limit.retryAfter(visitor);
      const retryable = Number.isFinite(wait);
      return eventStream(async (send) =>
        send({
          event: 'error',
          data: {
            message: LIMITED,
            retryable,
            ...(retryable ? { retryAfterMs: Math.ceil(wait) } : {}),
          },
        }),
      );
    }
  }
  const deadline = started + TURN_DEADLINE_MS;
  const context = { scripted, streamed, started, headers };
  if (!streamed) {
    const result = await route.take(input, { deadline });
    logTurn(result, context);
    return Response.json(result.turn);
  }
  return eventStream(
    async (send, signal) => {
      const result = await route.take(input, { deadline, signal, emit: send });
      logTurn(result, { ...context, stopped: signal.aborted });
      const { turn, failure } = result;
      // Nobody is listening.
      if (signal.aborted) return;
      // Nothing was done: the person can simply ask again.
      if (failure !== undefined) {
        send({ event: 'error', data: { message: turn.say, retryable: true } });
        return;
      }
      send({ event: 'done', data: { say: turn.say, calls: turn.calls } });
    },
    { signal: request.signal },
  );
}

/** One line per turn: how it went and how long it took, never what was said. */
function logTurn(
  { turn, failure }: Awaited<ReturnType<TurnRoute['take']>>,
  context: {
    scripted: boolean;
    streamed: boolean;
    started: number;
    headers: Headers;
    stopped?: boolean;
  },
): void {
  const { scripted, streamed, headers } = context;
  const ms = Date.now() - context.started;
  if (context.stopped) {
    log('INFO', 'turn stopped', { scripted, calls: turn.calls.length, ms }, headers);
  } else if (failure === undefined) {
    log('INFO', 'turn', { scripted, streamed, calls: turn.calls.length, ms }, headers);
  } else {
    // The person still hears something. The log gets the error's name, code and status, not its
    // message, which can carry parts of the conversation.
    const { code, status } = (failure ?? {}) as { code?: unknown; status?: unknown };
    log(
      'ERROR',
      'turn failed',
      {
        error: failure instanceof Error ? failure.name : 'Error',
        code: typeof code === 'string' ? code : undefined,
        status: typeof status === 'number' ? status : undefined,
        ms,
      },
      headers,
    );
  }
}
