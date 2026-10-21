import { describe, expect, test } from 'vitest';
import { type Effect, type HandsFree, type HandsFreeEvent, hears, next, OFF } from './machine.ts';

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
});
