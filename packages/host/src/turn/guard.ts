/**
 * What the model may say (decision 108). After a check, a commit, an undo or a new rule, the
 * engine's own sentences carry the verdict and the question; the model only explains, and each
 * of its sentences is filtered before anyone sees or hears it. What a sentence may hold depends on
 * the turn it's in (Context). Dropping a sentence costs only flavour; nothing unfiltered goes out.
 * Pure: no I/O, nothing logged here.
 */

/**
 * The turn a reply belongs to:
 * - plan: a call that speaks (a check, a commit, an undo, a rule) came back this turn;
 * - anchored: no call this turn, after a call that spoke earlier, and the person asks about it
 *   ("why?", "what does that mean?", "tell me more");
 * - read: only read-only calls this turn (the home's state, the activity log);
 * - chat: no call this turn, and nothing asked about a check: small talk, thanks, a no.
 */
export type Context = 'plan' | 'anchored' | 'read' | 'chat';

/** Why a sentence was dropped, which is all that's ever logged about it. */
export type Dropped =
  | 'verdict'
  | 'action'
  | 'question'
  | 'state'
  | 'fragment'
  | 'time'
  | 'number'
  | 'plain'
  | 'long';
