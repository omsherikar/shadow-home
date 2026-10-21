/**
 * The wake word in what the browser heard. Speech recognition writes "Alexa" in several ways, so
 * a few of its usual mishearings count too, but only as the first thing said: some of them are
 * ordinary words ("Alexis" is a name), and in the middle of a sentence they aren't for her. Pure,
 * so it can be tested without a microphone.
 */

/** "Alexa" itself, as a whole word, anywhere. */
const ALEXA = /(?:^|[^\p{L}'])(alexa)(?='s\b|[^\p{L}']|$)/iu;
/** How recognition often mishears it, only at the start (after a "hey", if any). */
const MISHEARD = /^[\s,.!?]*(?:hey[\s,]+)?(alexia|alexis|elexa|a lexa)(?=[^\p{L}']|$)/iu;

/** Not woken; or woken, with the request said after the wake word (empty when there was none). */
export type Wake = { woke: false } | { woke: true; request: string };

/**
 * Whether `heard` holds the wake word and, if so, what was asked after it: "Alexa, I'm away for
 * the weekend" asks "I'm away for the weekend"; "Alexa" alone asks nothing yet. Words before the
 * wake word ("hey") are dropped, and so is a wake word said twice.
 */
export function parseWake(heard: string): Wake {
  const m = ALEXA.exec(heard) ?? MISHEARD.exec(heard);
  if (!m) return { woke: false };
  const rest = heard
    .slice(m.index + m[0].length)
    .replace(/^'s\b/i, '')
    .replace(/^[\s,.!?:;-]+/, '')
    .trim();
  // "Alexa, Alexa, turn the lights off".
  if (ALEXA.exec(rest)?.index === 0 || MISHEARD.test(rest)) return parseWake(rest);
  return { woke: true, request: rest };
}
