import { z } from 'zod';
import { loadBeats } from '@/turn/beats.ts';
import { bedrockModel } from '@/turn/bedrock.ts';
import { sceneTimeFor } from '@/turn/demo-clock.ts';
import { connectTools } from '@/turn/mcp.ts';
import { runTurn } from '@/turn/run.ts';
import { scriptedModel } from '@/turn/scripted.ts';
import type { Names, TurnRequest } from '@/turn/types.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const turnRequest = z.object({
  text: z.string().min(1).max(500),
  history: z
    .array(
      z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
        structuredContent: z.record(z.string(), z.unknown()).optional(),
        by: z.literal('screen').optional(),
      }),
    )
    .max(50),
  names: z
    .custom<Names>((v) => v === undefined || (typeof v === 'object' && v !== null))
    .optional(),
  screen: z.string().max(2000).optional(),
});

/** Ready to talk. Health checks (and browser tests) call it, which also compiles the route in dev. */
export function GET(): Response {
  return Response.json({ ready: true });
}

/**
 * One conversational turn. Bedrock decides by default; DEMO_MODE=1 (the replayed demo) and
 * MOCK_MODEL=1 (no AWS account) use the scripted model, which makes no model calls. With
 * DEMO_CLOCK=1, a demo line first moves home time to its scene.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = turnRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad turn request' }, { status: 400 });
  const beats = await loadBeats();
  if (process.env.DEMO_CLOCK === '1') await sceneTimeFor(parsed.data.text, beats);

  const tools = await connectTools();
  try {
    const scripted = process.env.DEMO_MODE === '1' || process.env.MOCK_MODEL === '1';
    const model = scripted
      ? scriptedModel(beats)
      : bedrockModel({
          // The AWS SDK loads only when Bedrock is used, so the scripted model starts fast.
          converse: (await import('@/turn/aws.ts')).bedrockConverse(),
          ...(process.env.BEDROCK_MODEL_ID ? { modelId: process.env.BEDROCK_MODEL_ID } : {}),
          tools: tools.modelTools,
          home: await tools.homeBrief(),
          ...(tools.instructions ? { serverInstructions: tools.instructions } : {}),
        });
    const turn = await runTurn(model, tools, parsed.data as TurnRequest);
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
