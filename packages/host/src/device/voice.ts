/**
 * The device's ears and voice. Speech comes from /api/speak (ElevenLabs, or Polly) a sentence at a
 * time, so the first is heard while the rest are still being written; if that isn't available (no
 * key, no account), from the browser's own voice. Listening uses the browser's speech recognition,
 * which Chrome provides.
 */
import { type Clip, speechQueue } from './speech-queue.ts';

let voiceAvailable = true;

/** How long a clip may take to come from /api/speak before the browser's voice says it instead. */
export const CLIP_WAIT_MS = 12_000;

/**
 * One sentence's clip from /api/speak. 503 (no voice, or this instance has spoken enough this
 * hour): the browser speaks for the rest of the session. 429 (this visitor has heard enough this
 * hour): the browser says the rest of this answer, and the next asks again. Anything else (400: a
 * line too long) is this sentence only.
 */
async function fetchClip(text: string, signal: AbortSignal): Promise<Clip> {
  if (!voiceAvailable) return { kind: 'browser', refused: true };
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (res.ok) return { kind: 'audio', audio: await res.blob() };
    if (res.status === 503) voiceAvailable = false;
    return { kind: 'browser', refused: res.status === 503 || res.status === 429 };
  } catch {
    // Stopped: nothing to say. Unreachable: the browser speaks from now on.
    if (signal.aborted) return { kind: 'browser', refused: false };
    voiceAvailable = false;
    return { kind: 'browser', refused: true };
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

function playAudio(blob: Blob, signal: AbortSignal): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  return new Promise((resolve) => {
    const done = (heard: boolean) => {
      signal.removeEventListener('abort', stop);
      URL.revokeObjectURL(url);
      resolve(heard);
    };
    const stop = () => {
      audio.pause();
      done(false);
    };
    signal.addEventListener('abort', stop, { once: true });
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
    const utterance = new SpeechSynthesisUtterance(text);
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

export function canListen(): boolean {
  return recognitionCtor() !== undefined;
}

/**
 * Listen for one thing said. `onHeard` gets the words so far, as they're recognised; `result`
 * resolves with the final words when the person stops talking (empty if nothing was heard).
 */
export function listenOnce(onHeard: (words: string) => void): {
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
