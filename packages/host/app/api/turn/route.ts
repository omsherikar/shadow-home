import { hourlyCaps, perHour } from '@/limit.ts';
import { log } from '@/log.ts';
import { fromOtherSite, OTHER_SITE } from '@/origin.ts';
import { loadBeats } from '@/turn/beats.ts';
import { bedrockModel } from '@/turn/bedrock.ts';
import { sceneTimeFor } from '@/turn/demo-clock.ts';
import { connectTools } from '@/turn/mcp.ts';
import { liveModel } from '@/turn/providers.ts';
import { turnRequest } from '@/turn/request.ts';
import { TURN_DEADLINE_MS } from '@/turn/run.ts';
import { scriptedModel } from '@/turn/scripted.ts';
import { takeTurn } from '@/turn/turn.ts';
import type { TurnRequest } from '@/turn/types.ts';
import { visitorOf } from '@/visitor.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Each live turn spends model calls on the owner's key; the site is public, so this instance takes
// at most LIVE_TURNS_PER_HOUR (default 60), and each visitor at most LIVE_TURNS_PER_VISITOR_HOUR
// (default 20), so one script can't use the hour up for everyone. A turn either refuses counts
// against neither. Scripted and demo turns cost nothing and don't count.
const liveTurns = hourlyCaps(
  perHour('LIVE_TURNS_PER_HOUR', 60),
  perHour('LIVE_TURNS_PER_VISITOR_HOUR', 20),
);

/** Ready to talk. Health checks (and browser tests) call it, which also compiles the route in dev. */
export function GET(): Response {
  return Response.json({ ready: true });
}

/**
 * One conversational turn. A live model decides by default (the Anthropic API, or Bedrock with
 * MODEL_PROVIDER=bedrock); DEMO_MODE=1 (the replayed demo) and MOCK_MODEL=1 (no model key) use the
 * scripted model, which makes no model calls. With DEMO_CLOCK=1, a demo line first moves home time
 * to its scene.
 */
export async function POST(request: Request): Promise<Response> {
  if (fromOtherSite(request)) return OTHER_SITE();
  const started = Date.now();
  const { headers } = request;
  const parsed = turnRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad turn request' }, { status: 400 });
  const scripted = process.env.DEMO_MODE === '1' || process.env.MOCK_MODEL === '1';
  if (!scripted && liveTurns(visitorOf(request)) !== 'ok') {
    return Response.json({
      say: "I've had a lot of requests this hour. Try again later.",
      calls: [],
    });
  }
  const beats = await loadBeats();
  if (process.env.DEMO_CLOCK === '1') await sceneTimeFor(parsed.data.text, beats);

  const { turn, failure } = await takeTurn(parsed.data as TurnRequest, {
    connect: (deadline) => connectTools({ deadline }),
    model: async (tools, home) =>
      scripted
        ? scriptedModel(beats)
        : bedrockModel({
            ...(await liveModel()),
            tools: tools.modelTools,
            home,
            ...(tools.instructions ? { serverInstructions: tools.instructions } : {}),
          }),
    // Setting up and the model's steps share one deadline from when the turn started.
    deadline: started + TURN_DEADLINE_MS,
  });
  const ms = Date.now() - started;
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
  return Response.json(turn);
}
