import { describe, expect, test } from 'vitest';
import { MAX_TEXT, spokenText } from './bounds.ts';
import { turnRequest } from './request.ts';

describe('what a turn may carry', () => {
  test('what the person says is at most 300 characters, as a request or a rule is', () => {
    expect(MAX_TEXT).toBe(300);
    expect(turnRequest.safeParse({ text: 'a'.repeat(300), history: [] }).success).toBe(true);
    expect(turnRequest.safeParse({ text: 'a'.repeat(301), history: [] }).success).toBe(false);
  });

  test('a long spoken line is cut to 300 characters, so its turn is accepted', () => {
    expect(spokenText('  Lights off.  ')).toBe('Lights off.');
    const long = spokenText(`${'word '.repeat(100)}`);
    expect(long.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(turnRequest.safeParse({ text: long, history: [] }).success).toBe(true);
    // Never half of a character written as two code units.
    const emoji = spokenText(`${'a'.repeat(299)}😀 and more`);
    expect(emoji).toBe('a'.repeat(299));
  });
});
