import { describe, expect, test } from 'vitest';
import { type Clip, speechQueue, type Voice } from './speech-queue.ts';

const WEEKEND =
  "Blocked: that breaks 4 house rules. No coffee maker running when nobody's home. That's Om's rule. Do it with 4 fixes instead?";

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

  test('the sentences play in order, each clip asked for once the one before has answered', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    for (const piece of WEEKEND.match(/.{1,7}/g) ?? []) speech.write(piece);
    await settle();
    // One request at a time.
    expect(v.asked).toEqual(['Blocked: that breaks 4 house rules.']);
    const said = speech.finish(WEEKEND);
    await v.drain();
    await said;
    expect(v.asked).toEqual([
      'Blocked: that breaks 4 house rules.',
      "No coffee maker running when nobody's home.",
      "That's Om's rule.",
      'Do it with 4 fixes instead?',
    ]);
    expect(v.played.map((p) => p.text)).toEqual(v.asked);
  });

  test('an answer that never streamed is said whole at the end, sentence by sentence', async () => {
    const v = fakeVoice();
    const said = speechQueue(v.voice).finish(WEEKEND);
    await v.drain();
    await said;
    expect(v.played).toHaveLength(4);
  });

  test('when the end says the same with other spacing, nothing is said twice', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    speech.write('Done:  10 changes. ');
    speech.write('Anything else?');
    const said = speech.finish('Done: 10 changes.\nAnything else?');
    await v.drain();
    await said;
    expect(v.played.map((p) => p.text)).toEqual(['Done: 10 changes.', 'Anything else?']);
  });
});

describe('when the end replaces what streamed', () => {
  test('what was queued is dropped and only the final words are said', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    speech.write("It's safe, I think. Shall I");
    await settle();
    expect(v.asked).toEqual(["It's safe, I think."]);
    const said = speech.finish('Blocked: that breaks 4 house rules.');
    await v.drain();
    await said;
    expect(v.played.map((p) => p.text)).toEqual(['Blocked: that breaks 4 house rules.']);
  });
});
