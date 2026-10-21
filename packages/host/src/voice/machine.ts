/**
 * Hands-free, as a small state machine: listening for "Alexa", awake for a request, a turn under
 * way, her voice, then listening for an answer when she asked something. Pure: each event gives
 * the next state and what to do, and the page does
 * it. Whether the microphone listens follows from the state alone (`hears`).
 */

/**
 * off: not listening. idle: listening for "Alexa". awake: "Alexa" heard alone, listening for the
 * request. thinking: a turn is under way. speaking: her voice is playing. answer: she asked
 * something and is listening for the reply, no wake word needed.
 */
export type Mode = 'off' | 'idle' | 'awake' | 'thinking' | 'speaking' | 'answer';

export interface HandsFree {
  mode: Mode;
}

export const OFF: HandsFree = { mode: 'off' };

/** Whether the microphone should be listening in this mode: never while she thinks or speaks. */
export function hears(mode: Mode): boolean {
  return mode === 'idle' || mode === 'awake' || mode === 'answer';
}
