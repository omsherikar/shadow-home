/**
 * The wake word in what the browser heard. Pure, so it can be tested without a microphone.
 */

/** "Alexa" itself, as a whole word, anywhere. */
const ALEXA = /(?:^|[^\p{L}'])(alexa)(?='s\b|[^\p{L}']|$)/iu;

/** Not woken; or woken, with the request said after the wake word (empty when there was none). */
export type Wake = { woke: false } | { woke: true; request: string };

/**
 * Whether `heard` holds the wake word and, if so, what was asked after it: "Alexa, I'm away for
 * the weekend" asks "I'm away for the weekend"; "Alexa" alone asks nothing yet. Words before the
 * wake word ("hey") are dropped.
 */
export function parseWake(heard: string): Wake {
  const m = ALEXA.exec(heard);
  if (!m) return { woke: false };
  const rest = heard
    .slice(m.index + m[0].length)
    .replace(/^'s\b/i, '')
    .replace(/^[\s,.!?:;-]+/, '')
    .trim();
  return { woke: true, request: rest };
}
