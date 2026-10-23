/**
 * The device's ears and voice. Speech comes from /api/speak (ElevenLabs, or Polly) a sentence at a
 * time, so the first is heard while the rest are still being written; if that isn't available (no
 * key, no account), from the browser's own voice. Listening uses the browser's speech recognition,
 * which Chrome provides.
 */
import { type Clip, speechQueue } from './speech-queue.ts';

let voiceAvailable = true;

/**
 * The words as they should be heard: a voice reads "20 °C" as "20 degree C", so units are spelled
 * out for speech only; the screen keeps the short form.
 */
export function forSpeech(text: string): string {
  return text
    .replace(/(\d)\s*°\s*C\b/g, '$1 degrees Celsius')
    .replace(/(\d)\s*°\s*F\b/g, '$1 degrees Fahrenheit')
    .replace(/°/g, ' degrees');
}

/** How long a clip may take to come from /api/speak before the browser's voice says it instead. */
export const CLIP_WAIT_MS = 12_000;

/**
 * One sentence's clip from /api/speak. 503 (no voice, or this instance has spoken enough this
 * hour): the browser speaks for the rest of the session. 429 (this visitor has heard enough this
 * hour): the browser says the rest of this answer, and the next asks again. Anything else (400: a
 * line too long) is this sentence only. A clip that hasn't come after CLIP_WAIT_MS, or a request
 * that fails, is given up on for this sentence only: a slow first clip (a server starting up, a
 * route compiling) shouldn't leave the browser's voice for the rest of the visit.
 */
async function fetchClip(text: string, signal: AbortSignal): Promise<Clip> {
  if (!voiceAvailable) return { kind: 'browser', refused: true };
  // A clip that doesn't come in time (a stalled request) isn't waited for any longer.
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(), CLIP_WAIT_MS);
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: forSpeech(text) }),
      signal: AbortSignal.any([signal, late.signal]),
    });
    if (res.ok) return { kind: 'audio', audio: await res.blob() };
    if (res.status === 503) voiceAvailable = false;
    return { kind: 'browser', refused: res.status === 503 || res.status === 429 };
  } catch {
    // Stopped, unreachable or too slow: the browser says this sentence, and the next asks again.
    return { kind: 'browser', refused: false };
  } finally {
    clearTimeout(timer);
  }
}

const held = new Set<() => void>();

/**
 * Hear when the browser holds her voice back (it plays sound only after a tap on the page), so
 * the page can offer a tap to hear her. Returns how to stop hearing it.
 */
export function watchHeldBack(watcher: () => void): () => void {
  held.add(watcher);
  return () => held.delete(watcher);
}

const heldBack = (e: unknown) => {
  if ((e as { name?: unknown } | null)?.name !== 'NotAllowedError') return;
  for (const w of held) w();
};

/**
 * Say one sentence: its clip, or the browser's voice. Stops at once when the signal aborts.
 * Resolves true when it was heard to the end.
 */
function playClip(clip: Clip, text: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  try {
    return clip.kind === 'audio' ? playAudio(clip.audio, signal) : browserVoice(text, signal);
  } catch {
    // No way to play it here (no audio element): the words are on screen.
    return Promise.resolve(false);
  }
}

/** How long a clip may play past its own length before it counts as over. */
const PLAY_MARGIN_MS = 2_000;
/** How long a clip whose length isn't known yet may play before it counts as over. */
const UNKNOWN_LENGTH_MS = 10_000;

/**
 * How long to let a clip play before it counts as over, heard or not: its length plus a margin
 * from when it starts playing, or 10 s while its length isn't known. A clip whose sound never moves on (no audio output, a
 * stalled stream) would otherwise keep her "speaking" for good, and the next sentence waiting.
 */
export function playLimitMs(lengthSeconds: number): number {
  return Number.isFinite(lengthSeconds) && lengthSeconds > 0
    ? Math.ceil(lengthSeconds * 1000) + PLAY_MARGIN_MS
    : UNKNOWN_LENGTH_MS;
}

function playAudio(blob: Blob, signal: AbortSignal): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  return new Promise((resolve) => {
    let limit: ReturnType<typeof setTimeout> | undefined;
    let over = false;
    const done = (heard: boolean) => {
      if (over) return;
      over = true;
      clearTimeout(limit);
      signal.removeEventListener('abort', stop);
      URL.revokeObjectURL(url);
      resolve(heard);
    };
    const stop = () => {
      audio.pause();
      done(false);
    };
    // Past its limit it counts as over, and as not heard: her question may not have been.
    const allow = (ms: number) => {
      clearTimeout(limit);
      limit = setTimeout(stop, ms);
    };
    // Until it starts playing, the guard for a clip of unknown length; from then, its own length
    // and a margin, so playback that starts late (an audio device waking) isn't cut short.
    allow(playLimitMs(Number.NaN));
    signal.addEventListener('abort', stop, { once: true });
    audio.onplaying = () => allow(playLimitMs(audio.duration));
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    audio.play().catch((e: unknown) => {
      heldBack(e);
      done(false);
    });
  });
}

function browserVoice(text: string, signal: AbortSignal): Promise<boolean> {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth) return Promise.resolve(false);
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(forSpeech(text));
    utterance.lang = 'en-US';
    // Some browsers never fire `end`; don't let the conversation wait forever.
    const timer = setTimeout(() => done(true), 2000 + text.split(' ').length * 500);
    const done = (heard: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(heard);
    };
    const stop = () => {
      synth.cancel();
      done(false);
    };
    signal.addEventListener('abort', stop, { once: true });
    utterance.onend = () => done(true);
    utterance.onerror = (e) => {
      // Chrome says "not-allowed" when it won't speak before a tap.
      if (e.error === 'not-allowed') heldBack({ name: 'NotAllowedError' });
      done(false);
    };
    synth.speak(utterance);
  });
}

/** The device's voice: sentences as they stream in (`write`), then the answer as it ends. */
export const speech = speechQueue({ fetch: fetchClip, play: playClip });

/**
 * Say a whole reply out loud, cutting short whatever was being said. Resolves once it's said:
 * true when it was heard to the end.
 */
export function speak(text: string): Promise<boolean> {
  return speech.say(text);
}

/** Stop talking now: Stop, a mic tap, something new said, or the demo starting over. */
export function stopSpeaking(): void {
  speech.clear();
}

export interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}

export interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognitionCtor = new () => Recognition;

/** The browser's speech recognition, where it has one (Chrome, Edge, Safari; not Firefox). */
export function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** A browser that can record the microphone, for ElevenLabs to transcribe. */
function canRecord(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

export function canListen(): boolean {
  return recognitionCtor() !== undefined || canRecord();
}

let elevenReady: Promise<boolean> | undefined;

/** Whether the server transcribes recordings with ElevenLabs: asked once a page. */
function transcribesHere(): Promise<boolean> {
  if (!canRecord()) return Promise.resolve(false);
  elevenReady ??= fetch('/api/listen')
    .then((r) => (r.ok ? r.json() : { ready: false }))
    .then((b) => (b as { ready?: unknown }).ready === true)
    .catch(() => false);
  return elevenReady;
}

/** How loud counts as speaking, how long a pause ends it, and the longest a request may run. */
const SPEAKING_RMS = 0.03;
const PAUSE_MS = 1200;
const NOTHING_SAID_MS = 6000;
const LONGEST_MS = 15000;

/**
 * Record one request and have ElevenLabs transcribe it (/api/listen): it ends after a pause
 * once something was said, on stop(), or at LONGEST_MS. Resolves with the words, empty when
 * nothing was said; rejects when the transcription isn't available.
 */
function recordOnce(onHeard: (words: string) => void): { result: Promise<string>; stop(): void } {
  let finish = () => {};
  let stopEarly = false;
  const result = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const type =
      ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) =>
        MediaRecorder.isTypeSupported?.(t),
      ) ?? '';
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const ended = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const started = performance.now();
    let spokeAt = 0;
    let quietSince = 0;
    let done = false;
    finish = () => {
      if (done) return;
      done = true;
      if (recorder.state !== 'inactive') recorder.stop();
    };
    const listenForPause = () => {
      if (done) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += ((v - 128) / 128) ** 2;
      const level = Math.sqrt(sum / samples.length);
      const now = performance.now();
      if (level > SPEAKING_RMS) {
        spokeAt = now;
        quietSince = 0;
      } else if (spokeAt && !quietSince) quietSince = now;
      const paused = spokeAt > 0 && quietSince > 0 && now - quietSince > PAUSE_MS;
      const silent = spokeAt === 0 && now - started > NOTHING_SAID_MS;
      if (paused || silent || now - started > LONGEST_MS) finish();
      else setTimeout(listenForPause, 100);
    };
    recorder.start(250);
    if (stopEarly) finish();
    else setTimeout(listenForPause, 100);
    await ended;
    for (const track of stream.getTracks()) track.stop();
    void context.close();
    const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
    if (spokeAt === 0 || blob.size === 0) return '';
    onHeard('…');
    const res = await fetch('/api/listen', {
      method: 'POST',
      headers: { 'content-type': blob.type || 'audio/webm' },
      body: blob,
    });
    if (!res.ok) throw new Error(`listening is not available (${res.status})`);
    const body = (await res.json()) as { text?: unknown };
    return typeof body.text === 'string' ? body.text.trim() : '';
  })();
  return {
    result,
    stop: () => {
      stopEarly = true;
      finish();
    },
  };
}

/**
 * Listen for one thing said. `onHeard` gets the words so far, as they're recognised; `result`
 * resolves with the final words when the person stops talking (empty if nothing was heard).
 */
export function listenOnce(onHeard: (words: string) => void): {
  result: Promise<string>;
  stop(): void;
} {
  let stopped = false;
  let inner: { stop(): void } | undefined;
  const result = transcribesHere().then((eleven) => {
    if (stopped) return '';
    const session = eleven ? recordOnce(onHeard) : browserListen(onHeard);
    inner = session;
    if (!eleven) return session.result;
    // If ElevenLabs can't transcribe, the next request uses the browser's own recognition.
    return session.result.catch((e: unknown) => {
      elevenReady = Promise.resolve(false);
      if (recognitionCtor()) return '';
      throw e;
    });
  });
  return {
    result,
    stop: () => {
      stopped = true;
      inner?.stop();
    },
  };
}

/** The browser's own recognition, for one request: words as they're recognised, then the rest. */
function browserListen(onHeard: (words: string) => void): {
  result: Promise<string>;
  stop(): void;
} {
  const Ctor = recognitionCtor();
  if (!Ctor) return { result: Promise.reject(new Error('No speech recognition here')), stop() {} };
  const rec = new Ctor();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  let final = '';
  const result = new Promise<string>((resolve, reject) => {
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r) continue;
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      onHeard(`${final}${interim}`.trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') resolve('');
      else reject(new Error(e.error));
    };
    rec.onend = () => resolve(final.trim());
  });
  rec.start();
  return { result, stop: () => rec.stop() };
}
