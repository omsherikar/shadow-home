import { hourlyCaps, perHour } from './limit.ts';
import { log } from './log.ts';
import { fromOtherSite, OTHER_SITE } from './origin.ts';
import { visitorOf } from './visitor.ts';

/**
 * Speech to text for /api/listen (app/api/listen/route.ts), kept here so it can be tested.
 */

/** About a minute of compressed speech: far more than one request needs. */
const MAX_BYTES = 2_000_000;
const ELEVENLABS_STT = 'https://api.elevenlabs.io/v1/speech-to-text';

// Each transcription spends the owner's ElevenLabs credit, so this instance and each visitor get
// a number per hour; past either, the page listens with the browser's own recognition instead.
const listens = hourlyCaps(
  perHour('LISTENS_PER_HOUR', 300),
  perHour('LISTENS_PER_VISITOR_HOUR', 40),
);

function key(): string | undefined {
  return process.env.ELEVENLABS_API_KEY || undefined;
}

/** Whether the page should send its recordings here (a key, and not a silent test run). */
export function listenReady(): Response {
  return Response.json({ ready: key() !== undefined && process.env.SHADOW_HOME_SILENT !== '1' });
}

/**
 * Speech to text with ElevenLabs: the page posts one recording (audio/webm, or whatever its
 * MediaRecorder makes) and gets back `{ text }`. 503 when there's no key or this instance's hour
 * is used, 429 when this visitor's is, so the page falls back to the browser's recognition.
 */
export async function listen(request: Request): Promise<Response> {
  if (fromOtherSite(request)) return OTHER_SITE();
  const apiKey = key();
  if (!apiKey) return Response.json({ error: 'No speech to text here' }, { status: 503 });
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('audio/')) {
    return Response.json({ error: 'Send the recording as audio' }, { status: 400 });
  }
  const audio = await request.arrayBuffer();
  if (audio.byteLength === 0 || audio.byteLength > MAX_BYTES) {
    return Response.json({ error: 'That recording is empty or too long' }, { status: 400 });
  }
  const allowed = listens(visitorOf(request));
  if (allowed === 'visitor') {
    return Response.json({ error: 'You have spoken a lot this hour' }, { status: 429 });
  }
  if (allowed === 'instance') {
    return Response.json({ error: 'Listening is resting' }, { status: 503 });
  }
  const started = Date.now();
  try {
    const form = new FormData();
    form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v2');
    form.append('language_code', 'en');
    form.append('tag_audio_events', 'false');
    form.append('file', new Blob([audio], { type: type.split(';')[0] }), 'speech.webm');
    const res = await fetch(ELEVENLABS_STT, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // The status only: ElevenLabs' message can repeat what was said.
      log(
        'ERROR',
        'listen failed',
        { status: res.status, ms: Date.now() - started },
        request.headers,
      );
      return Response.json({ error: 'Listening is not available' }, { status: 503 });
    }
    const body = (await res.json()) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    log(
      'INFO',
      'listened',
      {
        bytes: audio.byteLength,
        words: text ? text.split(/\s+/).length : 0,
        ms: Date.now() - started,
      },
      request.headers,
    );
    return Response.json({ text });
  } catch (e) {
    log(
      'ERROR',
      'listen failed',
      { error: e instanceof Error ? e.name : 'Error', ms: Date.now() - started },
      request.headers,
    );
    return Response.json({ error: 'Listening is not available' }, { status: 503 });
  }
}
