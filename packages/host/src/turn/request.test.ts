import { describe, expect, test } from 'vitest';
import { MAX_TEXT } from './bounds.ts';
import { turnRequest } from './request.ts';

describe('what a turn may carry', () => {
  test('what the person says is at most 300 characters, as a request or a rule is', () => {
    expect(MAX_TEXT).toBe(300);
    expect(turnRequest.safeParse({ text: 'a'.repeat(300), history: [] }).success).toBe(true);
    expect(turnRequest.safeParse({ text: 'a'.repeat(301), history: [] }).success).toBe(false);
  });
});
