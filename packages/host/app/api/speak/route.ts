import { z } from 'zod';
import { hourlyLimit, perHour } from '@/limit.ts';
import { fromOtherSite, OTHER_SITE } from '@/origin.ts';
import { synthesize } from '@/turn/providers.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const speakRequest = z.object({ text: z.string().min(1).max(1500) });

// Speech is paid by the character; past SPEECH_PER_HOUR (default 120) on this instance the browser
// speaks instead.
const speech = hourlyLimit(perHour('SPEECH_PER_HOUR', 120));

/**
 * Text to speech as one MP3: ElevenLabs, or Amazon Polly with SPEECH=polly. 503 when the voice
 * isn't available or the hour's allowance is used, so the browser speaks with its own voice.
 */
export async function POST(request: Request): Promise<Response> {
  if (fromOtherSite(request)) return OTHER_SITE();
  const parsed = speakRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad speak request' }, { status: 400 });
  if (!speech()) return Response.json({ error: 'The voice is resting' }, { status: 503 });
  try {
    const audio = await synthesize(parsed.data.text);
    return new Response(Buffer.from(audio), { headers: { 'content-type': 'audio/mpeg' } });
  } catch (e) {
    console.error('speak:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'The voice is not available' }, { status: 503 });
  }
}
