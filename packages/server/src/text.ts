/**
 * Words a person typed or said, as the server keeps them: each run of whitespace (line breaks and
 * tabs too) is one space, and other control characters (Unicode `Cc`) are left out. A request is
 * kept in the shared activity log, which the voice model and the screen read back; a rule's words
 * go to the rule compiler's models.
 */
export function plainText(text: string): string {
  return text
    .replace(/(?!\s)\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
