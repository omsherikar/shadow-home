/** What the person said, at most: what the server takes as a request or a rule's words. */
export const MAX_TEXT = 300;

/**
 * What the person said, as a turn sends it: trimmed, and cut to MAX_TEXT. Typing stops there
 * already; speech recognition doesn't, and a longer line would otherwise fail its turn. A cut
 * never leaves half of a character written as two code units.
 */
export function spokenText(text: string): string {
  return text
    .trim()
    .slice(0, MAX_TEXT)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
}

/**
 * How much of the conversation one turn may carry, in characters of JSON. The browser sends its
 * recent history with every turn and the model reads part of it, so without a cap a script could
 * hand the model any amount of text. The full demo script, start to finish, sends at most about
 * 17,500 characters of history (20 entries); the largest result in it or in ShadowBench is the
 * weekend preview at about 9,000, and no call's arguments reach 1,000. The caps sit well above
 * that: as many entries as the browser keeps (41), with a weekend preview every turn, come to
 * about 130,000. The browser keeps within them itself (fitHistory), so a busy activity log never
 * locks a session out.
 */
export const MAX_HISTORY = 256_000;
/** Each history entry's arguments. */
export const MAX_ARGUMENTS = 16_000;
/** Each history entry's result. */
export const MAX_RESULT = 64_000;

/** At most `max` characters as JSON. A value nested too deep to serialize doesn't fit. */
export function fits(max: number) {
  return (value: unknown) => {
    try {
      return JSON.stringify(value).length <= max;
    } catch {
      return false;
    }
  };
}
