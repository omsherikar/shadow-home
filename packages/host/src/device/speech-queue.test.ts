import { describe, expect, test } from 'vitest';
import type { TurnEvent } from '../chat/stream.ts';
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

  test('a sentence of the old words playing when the end replaces them stops at once', async () => {
    // Not what decision 108's server sends (its stream is `say`), but if it ever differs, the old
    // words are cut off the moment the end says so, and only the final words follow.
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    speech.write("It's safe to run. Then");
    await v.arrive();
    const said = speech.finish('Blocked: that breaks 4 house rules.');
    await settle();
    expect(v.stopped).toEqual(["It's safe to run."]);
    const before = v.played.length;
    await v.drain();
    await said;
    expect(v.played.slice(before).map((p) => p.text)).toEqual([
      'Blocked: that breaks 4 house rules.',
    ]);
  });
});

/** A turn's events, as the turn route sends them. */
const step = (state: 'running' | 'done' | 'failed'): TurnEvent => ({
  type: 'step',
  id: 's1',
  tool: 'preview_plan',
  label: 'Checking',
  state,
});
const text = (delta: string): TurnEvent => ({ type: 'text', delta });
const done = (say: string): TurnEvent => ({ type: 'done', turn: { say, calls: [] } });

describe('following a turn as it streams', () => {
  test("a stream shaped like decision 108's says each sentence once, and nothing else", async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    const say =
      "Blocked: that breaks 4 house rules. The coffee maker would run at 7 with nobody home. That's Om's rule. Do it with 4 fixes instead?";
    const events = [
      step('running'),
      step('done'),
      {
        type: 'call',
        call: { name: 'preview_plan', arguments: {}, result: { content: [] } },
      } satisfies TurnEvent,
      text('Blocked: that breaks 4 house rules.'),
      text(' The coffee maker would run at 7 with nobody home.'),
      text(" That's Om's rule."),
      text(' Do it with 4 fixes instead?'),
      done(say),
    ];
    let said: Promise<void> | null = null;
    for (const event of events) said = speech.follow(event) ?? said;
    await v.drain();
    await said;
    expect(v.played.map((p) => p.text)).toEqual([
      'Blocked: that breaks 4 house rules.',
      'The coffee maker would run at 7 with nobody home.',
      "That's Om's rule.",
      'Do it with 4 fixes instead?',
    ]);
    expect(v.asked).toEqual(v.played.map((p) => p.text));
  });

  test('words before a step starts are never said: the step clears them', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    speech.follow(text('Let me check that on your home first. I'));
    await settle();
    // Its clip was asked for, but the step comes before it can play.
    expect(v.asked).toEqual(['Let me check that on your home first.']);
    speech.follow(step('running'));
    // The clip arrives after the step, still before any done: the step alone keeps it unsaid.
    await v.arrive();
    expect(v.played).toEqual([]);
    let said: Promise<void> | null = null;
    for (const event of [step('done'), text('Done: TV off.'), done('Done: TV off.')]) {
      said = speech.follow(event) ?? said;
    }
    await v.drain();
    await said;
    expect(v.played.map((p) => p.text)).toEqual(['Done: TV off.']);
    expect(v.played.map((p) => p.text)).not.toContain('Let me check that on your home first.');
  });

  test('a done whose say differs from what streamed clears it and says the replacement', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    speech.follow(text("It's safe to run, I think. Shall"));
    const said = speech.follow(done("I can't confirm that's safe. Run it anyway?"));
    await v.drain();
    await said;
    expect(v.played.map((p) => p.text)).toEqual(["I can't confirm that's safe.", 'Run it anyway?']);
  });

  test('an error clears what was queued; the page says what went wrong', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    speech.follow(text('Checking the garage. And'));
    speech.follow({ type: 'error', message: 'Sorry, something went wrong.', retryable: true });
    await v.drain();
    expect(v.played).toEqual([]);
  });
});

describe('whether she is speaking', () => {
  test('from the moment the first clip starts, until the last one ends', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    const seen: boolean[] = [];
    speech.watch((on) => seen.push(on));
    speech.follow(text('Blocked: that breaks 4 house rules. Shall'));
    await settle();
    // Asked for, not yet playing.
    expect(seen).toEqual([]);
    await v.arrive();
    expect(seen).toEqual([true]);
    const said = speech.follow(done('Blocked: that breaks 4 house rules. Shall I fix it?'));
    await v.drain();
    await said;
    expect(seen).toEqual([true, false]);
  });

  test('a mic tap while she speaks: stopped at once, and saying so', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    const seen: boolean[] = [];
    const stop = speech.watch((on) => seen.push(on));
    speech.say('Blocked: that breaks 4 house rules. Shall I fix it?');
    await v.arrive();
    expect(seen).toEqual([true]);
    // What the mic does first: stop her (then it listens).
    speech.clear();
    expect(seen).toEqual([true, false]);
    expect(v.stopped).toEqual(['Blocked: that breaks 4 house rules.']);
    await v.drain();
    expect(seen).toEqual([true, false]);
    stop();
    speech.say('Okay.');
    await v.drain();
    expect(seen).toEqual([true, false]);
  });
});

describe('stopping', () => {
  test('clears the queue and stops the sentence playing at once; nothing after it plays', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    const said = speech.finish(WEEKEND);
    await v.arrive();
    expect(v.played.map((p) => p.text)).toEqual(['Blocked: that breaks 4 house rules.']);
    speech.clear();
    await said;
    expect(v.stopped).toEqual(['Blocked: that breaks 4 house rules.']);
    await v.drain();
    expect(v.played).toHaveLength(1);
  });

  test('a clip still on its way is never played', async () => {
    const v = fakeVoice();
    const speech = speechQueue(v.voice);
    speech.finish('Okay, nothing changed.');
    await settle();
    expect(v.asked).toHaveLength(1);
    speech.clear();
    await v.drain();
    expect(v.played).toEqual([]);
  });
});
