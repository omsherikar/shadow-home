import { z } from 'zod';
import { hourlyCaps, perHour } from '@/limit.ts';
import { log } from '@/log.ts';
import { fromOtherSite, OTHER_SITE } from '@/origin.ts';
import { synthesize } from '@/turn/providers.ts';
import { visitorOf } from '@/visitor.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// What the device says is the server's speech fields (a headline, a reason and a question: at most
// 65 words) or the model's one short sentence. The longest real line, across every ShadowBench
// plan and the demo, is 172 characters (32 words); 600 holds 65 words of about 9 characters each.
// A longer line is refused, and the browser speaks it instead.
const speakRequest = z.object({ text: z.string().min(1).max(600) });

// Speech is paid by the character. This instance speaks at most SPEECH_CHARS_PER_HOUR (default
// 30,000) and each visitor at most SPEECH_CHARS_PER_VISITOR_HOUR (default 5,000), about eight
// times the whole demo; past either, the browser speaks instead. A line either refuses counts
// against neither.
const chars = hourlyCaps(
  perHour('SPEECH_CHARS_PER_HOUR', 30_000),
  perHour('SPEECH_CHARS_PER_VISITOR_HOUR', 5_000),
);

/**
 * Text to speech as one MP3: ElevenLabs, or Amazon Polly with SPEECH=polly. 503 when the voice
 * isn't available or this instance's hour is used, so the browser speaks for the rest of the
 * session; 429 when this visitor's hour is used, so the browser speaks that line only.
 */
export async function POST(request: Request): Promise<Response> {
  if (fromOtherSite(request)) return OTHER_SITE();
  const parsed = speakRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad speak request' }, { status: 400 });
  const { text } = parsed.data;
  const refused = chars(visitorOf(request), text.length);
  if (refused === 'visitor') {
    return Response.json({ error: 'You have heard a lot this hour' }, { status: 429 });
  }
  if (refused === 'instance') {
    return Response.json({ error: 'The voice is resting' }, { status: 503 });
  }
  const started = Date.now();
  try {
    const audio = await synthesize(text);
    log('INFO', 'spoke', { chars: text.length, ms: Date.now() - started }, request.headers);
    return new Response(Buffer.from(audio), { headers: { 'content-type': 'audio/mpeg' } });
  } catch (e) {
    // The voice's own reasons (no key, a refusal, no audio, too slow); never the words.
    const error = e instanceof Error ? { error: e.name, reason: e.message } : { error: 'Error' };
    log('ERROR', 'speech failed', { ...error, ms: Date.now() - started }, request.headers);
    return Response.json({ error: 'The voice is not available' }, { status: 503 });
  }
}
