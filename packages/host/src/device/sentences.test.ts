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

  test('a temperature, a time and a decimal stay inside their sentence', () => {
    expect(
      allSentences(
        'The garage holds 5 °C. It breaks Sat 10:37 PM. The house is at 9.7 °C now, the garage 4.5 °C.',
      ),
    ).toEqual([
      'The garage holds 5 °C.',
      'It breaks Sat 10:37 PM.',
      'The house is at 9.7 °C now, the garage 4.5 °C.',
    ]);
  });

  test('an abbreviation, or a lower-case word after a stop, does not end a sentence', () => {
    expect(allSentences('Dr. Om says hi. Run it e.g. when power is cheap.')).toEqual([
      'Dr. Om says hi.',
      'Run it e.g. when power is cheap.',
    ]);
    expect(allSentences('It is approx. ten minutes. Run it at 2 a.m. tomorrow.')).toEqual([
      'It is approx. ten minutes.',
      'Run it at 2 a.m. tomorrow.',
    ]);
  });
});
