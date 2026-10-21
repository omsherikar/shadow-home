import { describe, expect, test } from 'vitest';
import { allSentences } from './sentences.ts';

const WEEKEND =
  "Blocked: that breaks 4 house rules. No coffee maker running when nobody's home. That's Om's rule. Do it with 4 fixes instead?";

describe('sentences in whole words', () => {
  test('the weekend answer is four sentences, the last one a question', () => {
    expect(allSentences(WEEKEND)).toEqual([
      'Blocked: that breaks 4 house rules.',
      "No coffee maker running when nobody's home.",
      "That's Om's rule.",
      'Do it with 4 fixes instead?',
    ]);
  });
});
