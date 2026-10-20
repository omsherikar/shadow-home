import { describe, expect, test } from 'vitest';
import { visitorOf } from './visitor.ts';

const request = (forwardedFor?: string) =>
  new Request('http://localhost:3001/api/speak', {
    method: 'POST',
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });

describe('who a visitor is', () => {
  test("directly on Cloud Run: the rightmost entry, the address Google's front end saw", () => {
    expect(visitorOf(request('203.0.113.7'), 0)).toBe('203.0.113.7');
  });
});
