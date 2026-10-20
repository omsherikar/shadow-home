import { hourlyLimit, perHour } from '@/limit.ts';
import { fromOtherSite, OTHER_SITE } from '@/origin.ts';
import { loadBeats } from '@/turn/beats.ts';
import { bedrockModel, type HomeBrief } from '@/turn/bedrock.ts';
import { sceneTimeFor } from '@/turn/demo-clock.ts';
import { connectTools } from '@/turn/mcp.ts';
import { liveModel } from '@/turn/providers.ts';
import { turnRequest } from '@/turn/request.ts';
import { runTurn } from '@/turn/run.ts';
import { scriptedModel } from '@/turn/scripted.ts';
import type { Names, TurnRequest } from '@/turn/types.ts';

function namesOf(home: HomeBrief): Names {
  return {
    devices: Object.fromEntries(home.devices.map((d) => [d.id, { name: d.name, room: d.room }])),
    routines: Object.fromEntries(home.routines.map((r) => [r.id, r.name])),
    members: {},
  };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Each live turn spends model calls on the owner's key; the site is public, so this instance takes
// at most LIVE_TURNS_PER_HOUR (default 60). Scripted and demo turns cost nothing and don't count.
const liveTurns = hourlyLimit(perHour('LIVE_TURNS_PER_HOUR', 60));

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
  const parsed = turnRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad turn request' }, { status: 400 });
  const scripted = process.env.DEMO_MODE === '1' || process.env.MOCK_MODEL === '1';
  if (!scripted && !liveTurns()) {
    return Response.json({
      say: "I've had a lot of requests this hour. Try again later.",
      calls: [],
    });
  }
  const beats = await loadBeats();
  if (process.env.DEMO_CLOCK === '1') await sceneTimeFor(parsed.data.text, beats);

  const tools = await connectTools();
  try {
    const home = await tools.homeBrief();
    // Names come from the home itself, so what "the thermostat" means never depends on what the
    // browser happened to see before (a reload, a log with no names).
    const request: TurnRequest = { ...(parsed.data as TurnRequest), names: namesOf(home) };
    const model = scripted
      ? scriptedModel(beats)
      : bedrockModel({
          ...(await liveModel()),
          tools: tools.modelTools,
          home,
          ...(tools.instructions ? { serverInstructions: tools.instructions } : {}),
        });
    const turn = await runTurn(model, tools, request);
    return Response.json(turn);
  } catch (e) {
    // The person still hears something; the reason goes to the server log.
    console.error('turn:', e instanceof Error ? e.message : e);
    return Response.json({
      say: "Sorry, I can't reach my assistant model right now.",
      calls: [],
      error: e instanceof Error ? e.name : 'Error',
    });
  } finally {
    await tools.close();
  }
}
