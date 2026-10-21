/** What the person can see Alexa doing. */
export type Activity = 'idle' | 'listening' | 'thinking' | 'working' | 'answering' | 'speaking';

/** What the page itself tracks: the mic and the turn. Her voice reports speaking on its own. */
export type TurnActivity = Exclude<Activity, 'speaking'>;

/**
 * What the chat shows: listening above all (a mic tap stops her voice and listens), then a turn
 * under way, then her voice for as long as it lasts.
 */
export function shownActivity(turn: TurnActivity, speaking: boolean): Activity {
  if (turn !== 'idle') return turn;
  return speaking ? 'speaking' : 'idle';
}
