/**
 * Hands-free, as a small state machine: listening for "Alexa", awake for a request, a turn under
 * way, her voice, then listening for an answer when she asked something. Pure: each event gives
 * the next state and what to do, and the page does
 * it. Whether the microphone listens follows from the state alone (`hears`).
 */
import { parseWake } from './wake.ts';

/**
 * off: not listening. idle: listening for "Alexa". awake: "Alexa" heard alone, listening for the
 * request. thinking: a turn is under way. speaking: her voice is playing. answer: she asked
 * something and is listening for the reply, no wake word needed.
 */
export type Mode = 'off' | 'idle' | 'awake' | 'thinking' | 'speaking' | 'answer';

export interface HandsFree {
  mode: Mode;
}

export type HandsFreeEvent =
  | { type: 'on' }
  | { type: 'off' }
  /** A final transcript from the microphone. */
  | { type: 'heard'; text: string };

export type Effect = { kind: 'send'; text: string };

export const OFF: HandsFree = { mode: 'off' };

/** Whether the microphone should be listening in this mode: never while she thinks or speaks. */
export function hears(mode: Mode): boolean {
  return mode === 'idle' || mode === 'awake' || mode === 'answer';
}

type Step = { state: HandsFree; effects: Effect[] };

const stay = (state: HandsFree): Step => ({ state, effects: [] });

/** Send what was asked: a turn starts. */
function send(state: HandsFree, text: string): Step {
  return {
    state: { ...state, mode: 'thinking' },
    effects: [{ kind: 'send', text }],
  };
}

export function next(state: HandsFree, event: HandsFreeEvent): Step {
  if (event.type === 'on')
    return state.mode === 'off' ? stay({ ...OFF, mode: 'idle' }) : stay(state);
  if (event.type === 'off') return stay(OFF);
  if (state.mode === 'off') return stay(state);

  switch (event.type) {
    case 'heard': {
      if (!hears(state.mode)) return stay(state);
      const wake = parseWake(event.text);
      // Speech without the wake word isn't for her, and is never sent.
      if (!wake.woke || !wake.request) return stay(state);
      return send(state, wake.request);
    }
  }
}
