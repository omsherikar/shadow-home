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
