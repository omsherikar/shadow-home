/**
 * Alexa's voice, sentence by sentence: each sentence is asked for as soon as it's finished, and the
 * clips play in order. The voice itself (the network, the speaker) is passed in, so the order, the
 * clearing and the replacing can be tested without a browser.
 */
import { sentenceSplitter } from './sentences.ts';

/** One sentence's sound: a clip from /api/speak, or the browser's own voice saying it. */
export type Clip = { kind: 'audio'; audio: Blob } | { kind: 'browser'; refused: boolean };

export interface Voice {
  /**
   * The clip for one sentence. `refused` says /api/speak turned it down (429 or 503): the browser
   * says the rest of that answer.
   */
  fetch(text: string, signal: AbortSignal): Promise<Clip>;
  /** Say one sentence; resolves once it's said, or at once when `signal` aborts. */
  play(clip: Clip, text: string, signal: AbortSignal): Promise<void>;
}

interface Round {
  controller: AbortController;
  /** Sentences waiting to be played, each with its clip on the way. */
  waiting: { text: string; clip: Promise<Clip> }[];
  split: ReturnType<typeof sentenceSplitter>;
  /** The last clip asked for: each asks once the one before has answered. */
  asked: Promise<unknown>;
  playing: Promise<void> | null;
}

/** Words in one line, single-spaced. */
const line = (text: string) => text.replace(/\s+/g, ' ').trim();

function round(): Round {
  return {
    controller: new AbortController(),
    waiting: [],
    split: sentenceSplitter(),
    asked: Promise.resolve(),
    playing: null,
  };
}

export function speechQueue(voice: Voice) {
  const now = round();

  const queue = (r: Round, sentence: string) => {
    const text = line(sentence);
    const { signal } = r.controller;
    // One request at a time, in order.
    const clip = r.asked.then(async (): Promise<Clip> => {
      return voice.fetch(text, signal).catch((): Clip => ({ kind: 'browser', refused: false }));
    });
    r.asked = clip;
    r.waiting.push({ text, clip });
    r.playing ??= play(r);
  };

  const play = async (r: Round) => {
    const { signal } = r.controller;
    // Sentences queued while one plays join the same run.
    for (let next = r.waiting.shift(); next; next = r.waiting.shift()) {
      const clip = await next.clip;
      // A clip that can't play is skipped, not a reason to stop the rest.
      await voice.play(clip, next.text, signal).catch(() => undefined);
    }
    r.playing = null;
  };

  return {
    /** Words as they stream in: each sentence is queued once it's finished. */
    write(words: string): void {
      for (const sentence of now.split.push(words)) queue(now, sentence);
    },
  };
}
