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

export interface FilterFacts {
  context: Context;
  /** The home's device and routine names, taken out before a sentence is checked. */
  names: string[];
}

const HOUR_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const UNIT_WORDS = 'one|two|three|four|five|six|seven|eight|nine';
const TEEN_WORDS =
  'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const TEN_WORDS = 'twenty|thirty|forty|fifty';
const MERIDIEM = '([ap])\\.?\\s?m\\b\\.?';
/** Times as people say them, each with the hour, the minute if given, and a or p if given. */
const TIME_PATTERNS: RegExp[] = [
  // 10:37 PM, 9pm, 9 p.m.
  new RegExp(`\\b(\\d{1,2})(?::(\\d{2}))?\\s*${MERIDIEM}`, 'g'),
  // ten thirty-seven PM, seven oh five AM, ten o'clock PM
  new RegExp(
    `\\b(${HOUR_WORDS})(?:[ -](o'?clock|oh[ -](?:${UNIT_WORDS})|(?:${TEN_WORDS})(?:[ -](?:${UNIT_WORDS}))?|${TEEN_WORDS}))?\\s+${MERIDIEM}`,
    'g',
  ),
  // 22:37, 07:00
  /\b(\d{1,2}):(\d{2})\b/g,
  /\b(noon|midday|midnight)\b/g,
];

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

/**
 * The times in some text, each as the "hour:minute" keys it could mean on the 24-hour clock (one
 * without AM or PM, such as 10:30, could be either), and the text with them taken out. A time
 * that can't be one (37 PM) has no keys, so it matches nothing.
 */
export function timesIn(text: string): { times: string[][]; rest: string } {
  const times: string[][] = [];
  let rest = lower(text);
  for (const pattern of TIME_PATTERNS) {
    rest = rest.replace(pattern, (whole: string, hour?: string, minute?: string, ap?: unknown) => {
      times.push(timeKeys(whole, hour ?? '', minute, typeof ap === 'string' ? ap : ''));
      return ' ';
    });
  }
  return { times, rest };
}

function timeKeys(whole: string, hourText: string, minuteText: string | undefined, ap: string) {
  const key = (h: number, m: number) => `${h}:${m}`;
  if (whole === 'noon' || whole === 'midday') return [key(12, 0)];
  if (whole === 'midnight') return [key(0, 0)];
  const hour = /^\d+$/.test(hourText) ? Number(hourText) : wordNumber(hourText);
  const minute = minuteOf(minuteText);
  if (Number.isNaN(hour) || minute === null || minute > 59) return [];
  if (ap === 'a' || ap === 'p') {
    if (hour < 1 || hour > 12) return [];
    return [key((hour % 12) + (ap === 'p' ? 12 : 0), minute)];
  }
  if (hour > 23) return [];
  // 07:00 and 22:30 are the 24-hour clock; 7:00 and 10:30 could be morning or evening.
  if (hour === 0 || hour > 12 || /^0\d$/.test(hourText)) return [key(hour, minute)];
  return [key(hour % 12, minute), key((hour % 12) + 12, minute)];
}

function minuteOf(text: string | undefined): number | null {
  if (!text || /o'?clock/.test(text)) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  for (const word of text.split(/[ -]/).filter((w) => w && w !== 'oh')) {
    const n = wordNumber(word);
    if (Number.isNaN(n)) return null;
    total += n;
  }
  return total;
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

/** The facts a turn's sentences are checked against: the home's device and routine names. */
export function filterFacts(input: {
  context: Context;
  results: unknown[];
  devices: { id: string; name: string }[];
  routines: string[];
}): FilterFacts {
  const names = [...input.devices.map((d) => d.name), ...input.routines]
    .map(lower)
    .sort((a, b) => b.length - a.length);
  return {
    context: input.context,
    names,
  };
}
