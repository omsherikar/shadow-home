/**
 * The microphone, listening without a break: the browser's speech recognition, run continuously
 * and started again whenever it ends or fails. Chrome ends a session on its own after a stretch of
 * silence or a network hiccup, so ending is normal; only a refused microphone stops it for good.
 */
import type { RecognitionCtor } from '../device/voice.ts';

/** Errors after which the microphone won't work again until the person allows it. */
const LASTING = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);

/** Failures in a row (no network, the service down) after which it stops trying. */
export const GIVE_UP_AFTER = 5;

/** What `onError` reports when it has stopped trying: speech recognition isn't available. */
export const GAVE_UP = 'gave-up';

/** A beat before listening again after her voice, so its tail isn't heard as speech. */
export const RESUME_MS = 300;

/**
 * How long to wait before starting again: soon after a normal end, then longer while it keeps
 * failing (250 ms, 500, 1 s, 2 s, 4 s), never more than 5 s.
 */
export function restartDelay(failures: number): number {
  return Math.min(5000, 250 * 2 ** Math.max(0, failures));
}

export interface ListenerEvents {
  /** A finished piece of speech. */
  onFinal(text: string): void;
  /** The words so far of the piece still being spoken (empty when there are none). */
  onInterim(text: string): void;
  /**
   * `lasting`: listening has stopped for good, because the microphone was refused or (GAVE_UP)
   * recognition kept failing.
   */
  onError(error: string, lasting: boolean): void;
}

export interface Listener {
  /** Listen (again), after a short beat. */
  resume(): void;
  /** Stop listening for now; anything heard in the meantime is dropped. */
  pause(): void;
}

export function continuousListener(Ctor: RecognitionCtor, events: ListenerEvents): Listener {
  let wanted = false;
  let live: { rec: InstanceType<RecognitionCtor>; session: number } | null = null;
  // Each session's number: what an ended or paused session still reports is dropped.
  let session = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const later = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(begin, ms);
  };

  /** One more failure in a row: try again a little later, or stop once it keeps failing. */
  const failed = () => {
    failures += 1;
    if (failures < GIVE_UP_AFTER) return false;
    wanted = false;
    clearTimeout(timer);
    timer = undefined;
    events.onError(GAVE_UP, true);
    return true;
  };

  function begin() {
    timer = undefined;
    if (!wanted || live) return;
    session += 1;
    const mine = session;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    let heardAnything = false;
    let erred = false;
    const began = Date.now();
    rec.onresult = (e) => {
      if (mine !== session) return;
      heardAnything = true;
      failures = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (!result) continue;
        const words = result[0].transcript;
        if (result.isFinal) {
          if (words.trim()) events.onFinal(words.trim());
        } else interim += words;
      }
      events.onInterim(interim.trim());
    };
    rec.onerror = (e) => {
      if (mine !== session || e.error === 'aborted') return;
      if (LASTING.has(e.error)) {
        wanted = false;
        events.onError(e.error, true);
        return;
      }
      // Silence is normal; anything else (the network) counts towards waiting longer.
      if (e.error === 'no-speech') {
        events.onError(e.error, false);
        return;
      }
      erred = true;
      if (!failed()) events.onError(e.error, false);
    };
    rec.onend = () => {
      if (mine !== session) return;
      live = null;
      // A session that ends at once without hearing anything is failing, even with no error.
      if (!heardAnything && !erred && Date.now() - began < 1000 && failed()) return;
      if (wanted) later(restartDelay(failures));
    };
    live = { rec, session: mine };
    try {
      rec.start();
    } catch {
      live = null;
      if (!failed() && wanted) later(restartDelay(failures));
    }
  }

  return {
    resume() {
      if (wanted && (live || timer)) return;
      // Started afresh (turned on again, or after a pause): earlier failures no longer count.
      if (!wanted) failures = 0;
      wanted = true;
      later(RESUME_MS);
    },
    pause() {
      wanted = false;
      clearTimeout(timer);
      timer = undefined;
      session += 1;
      live?.rec.abort();
      live = null;
      events.onInterim('');
    },
  };
}
