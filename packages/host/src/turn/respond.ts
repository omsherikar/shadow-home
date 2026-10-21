import { log } from '../log.ts';
import { fromOtherSite, OTHER_SITE } from '../origin.ts';
import { visitorOf } from '../visitor.ts';
import { turnRequest } from './request.ts';
import { TURN_DEADLINE_MS } from './run.ts';
import type { TurnRequest, TurnResponse } from './types.ts';

/** What /api/turn needs from its surroundings; the route builds it from the environment. */
export interface TurnRoute {
  /** The scripted model answers (MOCK_MODEL, DEMO_MODE): no model calls, so no limit. */
  scripted: boolean;
  /** The hourly caps on live turns (limit.ts). */
  limit: (visitor: string) => 'ok' | 'visitor' | 'instance';
  /** One whole turn (takeTurn). */
  take(
    input: TurnRequest,
    options: { deadline: number },
  ): Promise<{ turn: TurnResponse & { error?: string }; failure?: unknown }>;
}

/**
 * One conversational turn over HTTP. A request from another site (403) and a bad request (400)
 * are refused as plain HTTP; otherwise the answer is the whole turn as JSON.
 */
export async function respondToTurn(request: Request, route: TurnRoute): Promise<Response> {
  if (fromOtherSite(request)) return OTHER_SITE();
  const started = Date.now();
  const { headers } = request;
  const parsed = turnRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad turn request' }, { status: 400 });
  const input = parsed.data as TurnRequest;
  const { scripted } = route;
  if (!scripted && route.limit(visitorOf(request)) !== 'ok') {
    return Response.json({
      say: "I've had a lot of requests this hour. Try again later.",
      calls: [],
    });
  }
  const deadline = started + TURN_DEADLINE_MS;
  const result = await route.take(input, { deadline });
  logTurn(result, { scripted, started, headers });
  return Response.json(result.turn);
}

/** One line per turn: how it went and how long it took, never what was said. */
function logTurn(
  { turn, failure }: Awaited<ReturnType<TurnRoute['take']>>,
  context: { scripted: boolean; started: number; headers: Headers },
): void {
  const { scripted, headers } = context;
  const ms = Date.now() - context.started;
  if (failure === undefined) {
    log('INFO', 'turn', { scripted, calls: turn.calls.length, ms }, headers);
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
