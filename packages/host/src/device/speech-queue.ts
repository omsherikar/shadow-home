/**
 * Alexa's voice, sentence by sentence: each sentence is asked for as soon as it's finished, and the
 * clips play in order. The voice itself (the network, the speaker) is passed in, so the order, the
 * clearing and the replacing can be tested without a browser.
 */
import type { TurnEvent } from '../chat/stream.ts';
import { allSentences, sentenceSplitter } from './sentences.ts';

/** One sentence's sound: a clip from /api/speak, or the browser's own voice saying it. */
export type Clip = { kind: 'audio'; audio: Blob } | { kind: 'browser'; refused: boolean };

export interface Voice {
  /**
   * The clip for one sentence. `refused` says /api/speak turned it down (429 or 503): the browser
   * says the rest of that answer.
   */
  fetch(text: string, signal: AbortSignal): Promise<Clip>;
  /**
   * Say one sentence; resolves once it's said, or at once when `signal` aborts: true when it was
   * heard to the end, false when it couldn't play (the browser held it back) or was cut short.
   */
  play(clip: Clip, text: string, signal: AbortSignal): Promise<boolean>;
}

interface Round {
  controller: AbortController;
  /** Sentences waiting to be played, each with its clip on the way. */
  waiting: { text: string; clip: Promise<Clip> }[];
  split: ReturnType<typeof sentenceSplitter>;
  /** Every sentence handed to the voice this round, in one line. */
  queued: string;
  refused: boolean;
  /** The last clip asked for: each asks once the one before has answered. */
  asked: Promise<unknown>;
  playing: Promise<void> | null;
  /** A sentence of this round couldn't play, or was cut short. */
  missed: boolean;
}

/** Words in one line, single-spaced, for comparing what streamed with what was said in the end. */
const line = (text: string) => text.replace(/\s+/g, ' ').trim();

function round(): Round {
  return {
    controller: new AbortController(),
    waiting: [],
    split: sentenceSplitter(),
    queued: '',
    refused: false,
    asked: Promise.resolve(),
    playing: null,
    missed: false,
  };
}

export function speechQueue(voice: Voice) {
  let now = round();
  // Whether a sentence is being said, for whoever shows it (watch).
  let speaking = false;
  const watchers = new Set<(speaking: boolean) => void>();
  const speakingIs = (on: boolean) => {
    if (on === speaking) return;
    speaking = on;
    for (const w of watchers) w(on);
  };

  const queue = (r: Round, sentence: string) => {
    const text = line(sentence);
    const { signal } = r.controller;
    // One request at a time, in order, so a refusal is known before the next sentence asks.
    const clip = r.asked.then(async (): Promise<Clip> => {
      if (signal.aborted) return { kind: 'browser', refused: false };
      if (r.refused) return { kind: 'browser', refused: true };
      const got = await voice
        .fetch(text, signal)
        .catch((): Clip => ({ kind: 'browser', refused: false }));
      if (got.kind === 'browser' && got.refused) r.refused = true;
      return got;
    });
    r.asked = clip;
    r.waiting.push({ text, clip });
    r.queued = line(`${r.queued} ${text}`);
    r.playing ??= play(r);
  };

  const play = async (r: Round) => {
    const { signal } = r.controller;
    // Sentences queued while one plays join the same run.
    for (let next = r.waiting.shift(); next && !signal.aborted; next = r.waiting.shift()) {
      const clip = await next.clip;
      if (signal.aborted) break;
      // Speaking from the moment the first clip starts, not when the answer has finished.
      speakingIs(true);
      // A clip that can't play is skipped, not a reason to stop the rest.
      const heard = await voice.play(clip, next.text, signal).catch(() => false);
      if (!heard) r.missed = true;
    }
    r.playing = null;
    // Everything said; a round that was cleared already said it stopped.
    if (r === now) speakingIs(false);
  };

  /** Stop at once: the sentence playing, every one waiting, and every clip on its way. */
  const clear = () => {
    now.controller.abort();
    now.waiting.length = 0;
    now = round();
    speakingIs(false);
  };

  /**
   * The answer as it ends, `say` being what was said in the end. When what streamed is how `say`
   * starts, the rest of `say` is queued after it; otherwise `say` replaced it (the guard's own
   * words), so what was queued is dropped and `say` is said instead. Resolves once all of it has
   * been said, or the voice was stopped: true when every sentence was heard to its end.
   */
  const finish = (say: string): Promise<boolean> => {
    const final = line(say);
    let r = now;
    if (r.queued && final !== r.queued && !final.startsWith(`${r.queued} `)) {
      clear();
      r = now;
    }
    for (const sentence of allSentences(final.slice(r.queued.length))) queue(r, sentence);
    r.split = sentenceSplitter();
    return (r.playing ?? Promise.resolve()).then(() => !r.missed && !r.controller.signal.aborted);
  };

  return {
    /** Words as they stream in: each sentence is queued once it's finished. */
    write(words: string): void {
      for (const sentence of now.split.push(words)) queue(now, sentence);
    },
    finish,
    /** Say this, and only this, cutting short whatever was being said. */
    say(text: string): Promise<boolean> {
      clear();
      return finish(text);
    },
    clear,
    /**
     * A turn's event, as it streams. A step starting clears whatever is queued or playing: words
     * written before a tool call aren't the answer (decision 108's server drops them), so nothing
     * of them is said. Words then queue sentence by sentence, and `done` says the rest of `say`, or
     * `say` instead of what streamed, resolving once it has been said. An error clears the queue;
     * the page says what went wrong.
     */
    follow(event: TurnEvent): Promise<boolean> | null {
      if (event.type === 'step' && event.state === 'running') clear();
      if (event.type === 'error') clear();
      if (event.type === 'text') {
        for (const sentence of now.split.push(event.delta)) queue(now, sentence);
      }
      return event.type === 'done' ? finish(event.turn.say) : null;
    },
    /** Hear whenever she starts or stops speaking; returns how to stop hearing it. */
    watch(watcher: (speaking: boolean) => void): () => void {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
  };
}
