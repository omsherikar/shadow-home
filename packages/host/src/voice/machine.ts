/**
 * Hands-free, as a small state machine: listening for "Alexa", awake for a request, a turn under
 * way, her voice, then listening for an answer when she asked something. Pure: each event gives
 * the next state and what to do (send a request, play the earcon, set a timer), and the page does
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
  /** A turn is running; her voice may start and stop within it. */
  turn: boolean;
  /** The last turn asked something: once her voice ends, listen for the answer. */
  asked: boolean;
  /** Counts each wait that has a timer, so a timer from an earlier one changes nothing. */
  epoch: number;
}

export type HandsFreeEvent =
  | { type: 'on' }
  | { type: 'off' }
  /** A final transcript from the microphone. */
  | { type: 'heard'; text: string }
  | { type: 'timeout'; epoch: number }
  | { type: 'turn-started' }
  /**
   * The turn and its voice are over; `asked` says whether it ended asking something the person
   * heard aloud.
   */
  | { type: 'turn-ended'; asked: boolean }
  | { type: 'speaking'; on: boolean }
  /** The Stop button. */
  | { type: 'stopped' };

export type Effect =
  | { kind: 'send'; text: string }
  | { kind: 'earcon' }
  | { kind: 'timer'; epoch: number; ms: number };

/** How long she waits for a request after "Alexa", or for an answer to her question. */
export const LISTEN_MS = 8000;

export const OFF: HandsFree = { mode: 'off', turn: false, asked: false, epoch: 0 };

/** Whether the microphone should be listening in this mode: never while she thinks or speaks. */
export function hears(mode: Mode): boolean {
  return mode === 'idle' || mode === 'awake' || mode === 'answer';
}

type Step = { state: HandsFree; effects: Effect[] };

const stay = (state: HandsFree): Step => ({ state, effects: [] });

/** Listening for something with a time limit: a fresh epoch and its timer. */
function waitFor(state: HandsFree, mode: 'awake' | 'answer', earcon: boolean): Step {
  const epoch = state.epoch + 1;
  return {
    state: { ...state, mode, epoch },
    effects: [
      ...(earcon ? [{ kind: 'earcon' } as const] : []),
      { kind: 'timer', epoch, ms: LISTEN_MS },
    ],
  };
}

/** Send what was asked: a turn starts. */
function send(state: HandsFree, text: string): Step {
  return {
    state: { ...state, mode: 'thinking', turn: true, asked: false },
    effects: [{ kind: 'send', text }],
  };
}

/** Her voice is over: listen for the answer if she asked something, otherwise for "Alexa". */
function afterSpeaking(state: HandsFree): Step {
  if (state.turn) return stay({ ...state, mode: 'thinking' });
  if (state.asked) return waitFor({ ...state, asked: false }, 'answer', false);
  return stay({ ...state, mode: 'idle' });
}

export function next(state: HandsFree, event: HandsFreeEvent): Step {
  if (event.type === 'on')
    return state.mode === 'off' ? stay({ ...OFF, mode: 'idle', epoch: state.epoch }) : stay(state);
  if (event.type === 'off') return stay({ ...OFF, epoch: state.epoch });
  if (state.mode === 'off') return stay(state);

  switch (event.type) {
    case 'heard': {
      if (!hears(state.mode)) return stay(state);
      const wake = parseWake(event.text);
      if (state.mode === 'idle') {
        // Speech without the wake word isn't for her, and is never sent.
        if (!wake.woke) return stay(state);
        return wake.request ? send(state, wake.request) : waitFor(state, 'awake', true);
      }
      // Awake, or listening for an answer: what's said is the request, wake word or not.
      const request = wake.woke ? wake.request : event.text.trim();
      if (request) return send(state, request);
      return wake.woke ? waitFor(state, 'awake', true) : stay(state);
    }
    case 'timeout':
      if (event.epoch !== state.epoch || (state.mode !== 'awake' && state.mode !== 'answer')) {
        return stay(state);
      }
      return stay({ ...state, mode: 'idle' });
    case 'turn-started':
      return stay({ ...state, mode: 'thinking', turn: true, asked: false });
    case 'turn-ended': {
      // No turn running (Stop ended it): nothing it says opens a window for an answer.
      if (!state.turn) return stay(state);
      const ended = { ...state, turn: false, asked: event.asked };
      return state.mode === 'speaking' ? stay(ended) : afterSpeaking(ended);
    }
    case 'speaking':
      if (event.on) return stay({ ...state, mode: 'speaking' });
      // Her voice ending matters only if that's what she was doing (not after a wake or a Stop).
      return state.mode === 'speaking' ? afterSpeaking(state) : stay(state);
    case 'stopped':
      return stay({ ...state, mode: 'idle', turn: false, asked: false, epoch: state.epoch + 1 });
  }
}
