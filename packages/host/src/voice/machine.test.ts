import { describe, expect, test } from 'vitest';
import {
  type Effect,
  type HandsFree,
  type HandsFreeEvent,
  hears,
  LISTEN_MS,
  next,
  OFF,
} from './machine.ts';

/** Runs events from a state, gathering every effect along the way. */
function run(events: HandsFreeEvent[], from: HandsFree = OFF) {
  let state = from;
  const effects: Effect[] = [];
  for (const event of events) {
    const step = next(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const on: HandsFreeEvent = { type: 'on' };
const heard = (text: string): HandsFreeEvent => ({ type: 'heard', text });
const sends = (effects: Effect[]) => effects.flatMap((e) => (e.kind === 'send' ? [e.text] : []));

describe('waking', () => {
  test('off until turned on; then listening for "Alexa"', () => {
    expect(OFF.mode).toBe('off');
    expect(hears('off')).toBe(false);
    const { state } = run([on]);
    expect(state.mode).toBe('idle');
    expect(hears(state.mode)).toBe(true);
  });

  test('"Alexa" with a request sends the request at once', () => {
    const { state, effects } = run([on, heard("Alexa, I'm away for the weekend")]);
    expect(sends(effects)).toEqual(["I'm away for the weekend"]);
    expect(state.mode).toBe('thinking');
  });

  test('"Alexa" alone plays the earcon and listens for the request, which needs no wake word', () => {
    const woke = run([on, heard('Alexa')]);
    expect(woke.state.mode).toBe('awake');
    expect(woke.effects).toEqual([
      { kind: 'earcon' },
      { kind: 'timer', epoch: woke.state.epoch, ms: LISTEN_MS },
    ]);
    const asked = run([heard('what did you change while I was away')], woke.state);
    expect(sends(asked.effects)).toEqual(['what did you change while I was away']);
    expect(asked.state.mode).toBe('thinking');
  });

  test('speech without the wake word is ignored and never sent', () => {
    const { state, effects } = run([on, heard('turn off the lights'), heard('yes')]);
    expect(effects).toEqual([]);
    expect(state.mode).toBe('idle');
  });

  test('awake with nothing said: back to listening for "Alexa" when the time is up', () => {
    const woke = run([on, heard('Alexa')]);
    const { state } = run([{ type: 'timeout', epoch: woke.state.epoch }], woke.state);
    expect(state.mode).toBe('idle');
  });

  test('a timer from an earlier wait changes nothing', () => {
    const first = run([on, heard('Alexa')]);
    const again = run([heard('Alexa')], first.state);
    expect(again.state.epoch).toBeGreaterThan(first.state.epoch);
    const { state } = run([{ type: 'timeout', epoch: first.state.epoch }], again.state);
    expect(state.mode).toBe('awake');
  });

  test('the mic button while on listens for a request, as "Alexa" would', () => {
    const { state, effects } = run([on, { type: 'wake' }]);
    expect(state.mode).toBe('awake');
    expect(effects[0]).toEqual({ kind: 'earcon' });
  });
});

describe('a turn, her voice, and the answer', () => {
  const asking = (): HandsFree => run([on, heard("Alexa, I'm away for the weekend")]).state;

  test('nothing is heard while she thinks or speaks', () => {
    const thinking = asking();
    expect(hears(thinking.mode)).toBe(false);
    const speaking = run([{ type: 'speaking', on: true }], thinking).state;
    expect(speaking.mode).toBe('speaking');
    expect(hears(speaking.mode)).toBe(false);
    // Even her own words, or someone saying "Alexa", don't start anything.
    const { effects } = run([heard('Alexa, do it with 4 fixes instead?')], speaking);
    expect(effects).toEqual([]);
  });

  test('after a question, once her voice ends, she listens for the answer with no wake word', () => {
    const { state } = run(
      [
        { type: 'speaking', on: true },
        { type: 'turn-ended', asked: true },
        { type: 'speaking', on: false },
      ],
      asking(),
    );
    expect(state.mode).toBe('answer');
    expect(hears(state.mode)).toBe(true);
    const answered = run([heard('yes')], state);
    expect(sends(answered.effects)).toEqual(['yes']);
  });

  test('the same when her voice ends before the turn does', () => {
    // A sentence said while the turn still runs is not the end of it.
    const between = run(
      [
        { type: 'speaking', on: true },
        { type: 'speaking', on: false },
      ],
      asking(),
    );
    expect(between.state.mode).toBe('thinking');
    const { state, effects } = run([{ type: 'turn-ended', asked: true }], between.state);
    expect(state.mode).toBe('answer');
    expect(effects).toEqual([{ kind: 'timer', epoch: state.epoch, ms: LISTEN_MS }]);
  });

  test('after an answer that asks nothing, back to listening for "Alexa"', () => {
    const { state } = run(
      [
        { type: 'speaking', on: true },
        { type: 'turn-ended', asked: false },
        { type: 'speaking', on: false },
      ],
      asking(),
    );
    expect(state.mode).toBe('idle');
    expect(sends(run([heard('yes')], state).effects)).toEqual([]);
  });

  test('a question nobody heard opens no window: the page says it was asked only if it was heard', () => {
    // Silent, or the browser held her voice back: the page ends the turn with asked false.
    const { state } = run([{ type: 'turn-ended', asked: false }], asking());
    expect(state.mode).toBe('idle');
  });

  test('no answer in time: back to listening for "Alexa"', () => {
    const waiting = run([{ type: 'turn-ended', asked: true }], asking()).state;
    const { state } = run([{ type: 'timeout', epoch: waiting.epoch }], waiting);
    expect(state.mode).toBe('idle');
  });

  test('a typed request while listening goes through as a turn too', () => {
    const waiting = run([{ type: 'turn-ended', asked: true }], asking()).state;
    const { state } = run([{ type: 'turn-started' }], waiting);
    expect(state.mode).toBe('thinking');
    // Its timer no longer applies.
    expect(run([{ type: 'timeout', epoch: waiting.epoch }], state).state.mode).toBe('thinking');
  });
});

describe('stopping, turning off, and the microphone failing', () => {
  test('Stop ends the turn and her voice, and listens for "Alexa" again', () => {
    const speaking = run([
      on,
      heard('Alexa, run the dishwasher'),
      { type: 'speaking', on: true },
    ]).state;
    const stopped = run([{ type: 'stopped' }, { type: 'speaking', on: false }], speaking);
    expect(stopped.state.mode).toBe('idle');
    expect(stopped.state.asked).toBe(false);
  });

  test('Stop while she asks her question: the turn ending after it opens no window', () => {
    const asking = run([
      on,
      heard("Alexa, I'm away for the weekend"),
      { type: 'speaking', on: true },
    ]).state;
    // Stopped mid-question; then the page's turn finishes and reports the question.
    const { state, effects } = run(
      [{ type: 'stopped' }, { type: 'speaking', on: false }, { type: 'turn-ended', asked: true }],
      asking,
    );
    expect(state.mode).toBe('idle');
    expect(effects).toEqual([]);
    // A stray "yes" is not for her.
    expect(run([heard('yes')], state).effects).toEqual([]);
  });

  test('the mic button while she speaks: awake, and her voice stopping and her turn ending change nothing', () => {
    // Her words are over and her voice still plays: the page is still waiting for it.
    const speaking = run([on, heard('Alexa, hello'), { type: 'speaking', on: true }]).state;
    expect(speaking.turn).toBe(true);
    // The button wakes her, then stops her voice; then the page's turn ends, cut short.
    const { state, effects } = run(
      [{ type: 'wake' }, { type: 'speaking', on: false }, { type: 'turn-ended', asked: false }],
      speaking,
    );
    expect(state.mode).toBe('awake');
    expect(effects[0]).toEqual({ kind: 'earcon' });
    // Not in the middle of a turn's words, though: the button is off then.
    const thinking = run([on, heard('Alexa, hello')]).state;
    expect(run([{ type: 'wake' }], thinking).state.mode).toBe('thinking');
  });
});
