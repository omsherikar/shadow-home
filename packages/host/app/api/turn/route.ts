import { z } from 'zod';
import { loadBeats } from '@/turn/beats.ts';
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
      }),
    )
    .max(50),
  names: z
    .custom<Names>((v) => v === undefined || (typeof v === 'object' && v !== null))
    .optional(),
  screen: z.string().max(2000).optional(),
});

/** One conversational turn. The scripted model stands in until the Bedrock loop is wired. */
export async function POST(request: Request): Promise<Response> {
  const parsed = turnRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad turn request' }, { status: 400 });
  const tools = await connectTools();
  try {
    const turn = await runTurn(scriptedModel(await loadBeats()), tools, parsed.data as TurnRequest);
    return Response.json(turn);
  } finally {
    await tools.close();
  }
}
