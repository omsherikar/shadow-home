import type { Mode } from '../voice/machine.ts';

/** What the person can see Alexa doing. */
export type Activity =
  | 'idle'
  | 'listening'
  | 'awaiting'
  | 'thinking'
  | 'working'
  | 'answering'
  | 'speaking';

/** What the page itself tracks: the mic button and the turn. The rest is reported to it. */
export type TurnActivity = Exclude<Activity, 'speaking' | 'awaiting'>;

/**
 * What the chat shows: listening above all (a mic tap stops her voice and listens), then a turn
 * under way, then her voice for as long as it lasts, then hands-free listening for a request
 * after "Alexa" (listening) or for the answer to her question (awaiting).
 */
export function shownActivity(
  turn: TurnActivity,
  speaking: boolean,
  handsFree: Mode = 'off',
): Activity {
  if (turn !== 'idle') return turn;
  if (speaking) return 'speaking';
  if (handsFree === 'awake') return 'listening';
  if (handsFree === 'answer') return 'awaiting';
  return 'idle';
}
