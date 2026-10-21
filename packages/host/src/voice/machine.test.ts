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
});

describe('a turn, her voice, and the answer', () => {
  const asking = (): HandsFree => run([on, heard("Alexa, I'm away for the weekend")]).state;

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
