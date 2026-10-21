import { hourlyCaps, perHour } from '@/limit.ts';
import { loadBeats } from '@/turn/beats.ts';
import { bedrockModel } from '@/turn/bedrock.ts';
import { sceneTimeFor } from '@/turn/demo-clock.ts';
import { connectTools } from '@/turn/mcp.ts';
import { liveModel } from '@/turn/providers.ts';
import { respondToTurn } from '@/turn/respond.ts';
import { scriptedModel } from '@/turn/scripted.ts';
import { takeTurn } from '@/turn/turn.ts';

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
 * One conversational turn (src/turn/respond.ts). A live model decides by default (the Anthropic
 * API, or Bedrock with MODEL_PROVIDER=bedrock); DEMO_MODE=1 (the replayed demo) and MOCK_MODEL=1
 * (no model key) use the scripted model, which makes no model calls. With DEMO_CLOCK=1, a demo
 * line first moves home time to its scene.
 */
export async function POST(request: Request): Promise<Response> {
  const scripted = process.env.DEMO_MODE === '1' || process.env.MOCK_MODEL === '1';
  return respondToTurn(request, {
    scripted,
    limit: liveTurns,
    async take(input, options) {
      const beats = await loadBeats();
      if (process.env.DEMO_CLOCK === '1') await sceneTimeFor(input.text, beats);
      return takeTurn(input, {
        ...options,
        connect: (deadline) => connectTools({ deadline }),
        model: async (tools, home) =>
          scripted
            ? scriptedModel(beats, home)
            : bedrockModel({
                ...(await liveModel()),
                tools: tools.modelTools,
                home,
                ...(tools.instructions ? { serverInstructions: tools.instructions } : {}),
              }),
      });
    },
  });
}
