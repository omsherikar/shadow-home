/**
 * Alexa's words cut into sentences as they stream in, so each can be spoken as soon as it's whole.
 * Pure functions, so they can be tested without a browser.
 */

// A sentence's end: its stops, any closing quotes or brackets, then a space and the next word,
// which has to have arrived before the sentence counts as finished (a "5." may become "5.5").
const END = /[.!?…]+["'”’)\]]*(\s+)(?=\S)/g;

/** The finished sentences at the start of `text`, and what follows them, not yet finished. */
export function finishedSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (const m of text.matchAll(END)) {
    const space = m[1] ?? '';
    const stop = m.index + m[0].length - space.length;
    const sentence = text.slice(start, stop).trim();
    if (sentence) sentences.push(sentence);
    start = stop + space.length;
  }
  return { sentences, rest: text.slice(start) };
}
