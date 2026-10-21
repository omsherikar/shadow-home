/**
 * The device's ears and voice. Speech comes from /api/speak (ElevenLabs, or Polly); if that isn't
 * available (no key, no account), from the browser's own voice. Listening uses the
 * browser's speech recognition, which Chrome provides.
 */
import { type Clip, speechQueue } from './speech-queue.ts';

let voiceAvailable = true;
/**
 * Aborted by every new reply and every stop: what's playing stops, and a reply still on its
 * way stays quiet.
 */
let current = new AbortController();

/** Say a reply out loud: one at a time. Resolves when it has finished, or was stopped. */
export async function speak(text: string): Promise<void> {
  stopSpeaking();
  const { signal } = current;
  if (!text.trim()) return;
  if (voiceAvailable) {
    try {
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const blob = await res.blob();
        // Stopped, or a newer reply started, while this one was on its way: stay quiet.
        return signal.aborted ? undefined : playAudio(blob, signal);
      }
      // 503: no voice, or this instance has spoken enough this hour. Don't ask again this
      // session; the browser's voice takes over. Anything else (429: this visitor has heard
      // enough this hour; 400: a line too long) is this line only, and the next asks again.
      if (res.status === 503) voiceAvailable = false;
    } catch {
      voiceAvailable = false;
    }
  }
  return signal.aborted ? undefined : browserVoice(text, signal);
}

/** Stop talking now: the person pressed the mic, said something new, or the demo started over. */
export function stopSpeaking(): void {
  current.abort();
  current = new AbortController();
}

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

/** Say one sentence: its clip, or the browser's voice. Stops at once when the signal aborts. */
function playClip(clip: Clip, text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  try {
    return clip.kind === 'audio' ? playAudio(clip.audio, signal) : browserVoice(text, signal);
  } catch {
    // No way to play it here (no audio element): the words are on screen.
    return Promise.resolve();
  }
}

function playAudio(blob: Blob, signal: AbortSignal): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', stop);
      URL.revokeObjectURL(url);
      resolve();
    };
    const stop = () => {
      audio.pause();
      done();
    };
    signal.addEventListener('abort', stop, { once: true });
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

function browserVoice(text: string, signal: AbortSignal): Promise<void> {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth) return Promise.resolve();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    // Some browsers never fire `end`; don't let the conversation wait forever.
    const timer = setTimeout(() => done(), 2000 + text.split(' ').length * 500);
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => {
      synth.cancel();
      done();
    };
    signal.addEventListener('abort', stop, { once: true });
    utterance.onend = done;
    utterance.onerror = done;
    synth.speak(utterance);
  });
}

/** The device's voice: sentences as they stream in (`write`), then the answer as it ends. */
export const speech = speechQueue({ fetch: fetchClip, play: playClip });

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
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
