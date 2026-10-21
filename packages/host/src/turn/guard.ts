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

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  dozen: 12,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

function lower(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'");
}

function wordNumber(word: string): number {
  if (word === 'one') return 1;
  return NUMBER_WORDS[word] ?? Number.NaN;
}

/**
 * The numbers in some text: digits not part of a name (R3, p1), and number words ("four",
 * "twenty-five", "third", "a dozen"). "One" and "first" aren't counted: "no one", "the one" and
 * "first, ..." aren't numbers.
 */
export function numbersIn(text: string): number[] {
  const t = lower(text).replace(/(\d),(\d{3})\b/g, '$1$2');
  const found = (t.match(/(?<![a-z\d.])\d+(?:\.\d+)?/g) ?? []).map(Number);
  const words = t.split(/[^a-z]+/);
  for (let i = 0; i < words.length; i++) {
    const n = NUMBER_WORDS[words[i] as string];
    if (n === undefined) continue;
    const unit = wordNumber(words[i + 1] ?? '');
    if (n >= 20 && n < 100 && unit < 10) {
      found.push(n + unit);
      i += 1;
    } else found.push(n);
  }
  return found;
}
