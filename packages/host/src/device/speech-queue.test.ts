import { describe, expect, test } from 'vitest';
import { type Clip, speechQueue, type Voice } from './speech-queue.ts';

/** Lets pending promises run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * A voice that records what it was asked for and what it played. Clips arrive when the test lets
 * them (`arrive`), and each sentence plays until the test ends it (`finishPlaying`) or the queue
 * stops it.
 */
function fakeVoice(answer: (text: string) => Clip = () => ({ kind: 'audio', audio: new Blob() })) {
  const asked: string[] = [];
  const played: { text: string; kind: Clip['kind'] }[] = [];
  const stopped: string[] = [];
  const pending: (() => void)[] = [];
  let playing: (() => void) | null = null;
  const voice: Voice = {
    fetch(text, signal) {
      asked.push(text);
      return new Promise((resolve, reject) => {
        pending.push(() => resolve(answer(text)));
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    },
    play(clip, text, signal) {
      played.push({ text, kind: clip.kind });
      return new Promise((resolve) => {
        playing = resolve;
        signal.addEventListener('abort', () => {
          stopped.push(text);
          resolve();
        });
      });
    },
  };
  return {
    voice,
    asked,
    played,
    stopped,
    /** Every clip asked for so far arrives. */
    async arrive() {
      await settle();
      for (let next = pending.shift(); next; next = pending.shift()) next();
      await settle();
    },
    /** The sentence playing ends. */
    async finishPlaying() {
      const done = playing;
      playing = null;
      done?.();
      await settle();
    },
    /** Let everything run to the end. */
    async drain() {
      for (let i = 0; i < 20; i++) {
        await this.arrive();
        await this.finishPlaying();
      }
    },
  };
}

describe('speaking an answer as it streams', () => {
  test('the first sentence is asked for as soon as it is finished, before the answer ends', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    speech.write('Blocked: that breaks 4 house ');
    await settle();
    expect(v.asked).toEqual([]);
    speech.write('rules. No coffee');
    await settle();
    expect(v.asked).toEqual(['Blocked: that breaks 4 house rules.']);
  });
});
