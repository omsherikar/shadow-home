/**
 * Alexa's words cut into sentences as they stream in, so each can be spoken as soon as it's whole.
 * Pure functions, so they can be tested without a browser.
 */

/** Words that end in a full stop without ending the sentence, lower-cased, without that stop. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'vs',
  'e.g',
  'i.e',
  'approx',
  'jr',
  'sr',
]);

// A sentence's end: its stops, any closing quotes or brackets, then a space and the next word,
// which has to have arrived before the sentence counts as finished (a "5." may become "5.5").
const END = /[.!?…]+["'”’)\]]*(\s+)(?=(\S))/g;

/** Whether a stop, followed by `next`, ends `sentence` (which runs up to and with its stops). */
function ends(sentence: string, next: string): boolean {
  // "approx. ten": a word in lower case carries the sentence on.
  if (/^\p{Ll}/u.test(next)) return false;
  const last = /(\S+?)[.]["'”’)\]]*$/.exec(sentence)?.[1];
  // "Dr. Om". A time ("at 2 p.m. Shall I?") or a single letter ("plan B. Then") followed by a
  // capital ends its sentence, as it nearly always does in what Alexa says.
  return last === undefined || !ABBREVIATIONS.has(last.toLowerCase());
}

/** The finished sentences at the start of `text`, and what follows them, not yet finished. */
export function finishedSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (const m of text.matchAll(END)) {
    const space = m[1] ?? '';
    const stop = m.index + m[0].length - space.length;
    const sentence = text.slice(start, stop).trim();
    if (!ends(sentence, m[2] ?? '')) continue;
    if (sentence) sentences.push(sentence);
    start = stop + space.length;
  }
  return { sentences, rest: text.slice(start) };
}

/**
 * Sentences from words arriving in pieces cut anywhere: `push` gives each sentence once it's
 * finished, and `end` the last one, when no more words are coming.
 */
export function sentenceSplitter() {
  let buffer = '';
  return {
    push(words: string): string[] {
      const { sentences, rest } = finishedSentences(buffer + words);
      buffer = rest;
      return sentences;
    },
    end(): string[] {
      const last = buffer.trim();
      buffer = '';
      return last ? [last] : [];
    },
  };
}

/** Every sentence of words already whole. */
export function allSentences(text: string): string[] {
  const split = sentenceSplitter();
  return [...split.push(text), ...split.end()];
}
