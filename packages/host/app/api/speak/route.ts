import { z } from 'zod';
import { fromOtherSite, OTHER_SITE } from '@/origin.ts';
import { synthesize } from '@/turn/providers.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const speakRequest = z.object({ text: z.string().min(1).max(1500) });

/**
 * Text to speech as one MP3: ElevenLabs, or Amazon Polly with SPEECH=polly. 503 when the voice
 * isn't available, so the browser speaks with its own voice instead.
 */
export async function POST(request: Request): Promise<Response> {
  if (fromOtherSite(request)) return OTHER_SITE();
  const parsed = speakRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad speak request' }, { status: 400 });
  try {
    const audio = await synthesize(parsed.data.text);
    return new Response(Buffer.from(audio), { headers: { 'content-type': 'audio/mpeg' } });
  } catch (e) {
    console.error('speak:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'The voice is not available' }, { status: 503 });
  }
}
