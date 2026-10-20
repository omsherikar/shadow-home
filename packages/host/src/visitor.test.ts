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

  test('entries a client forged on the left change nothing', () => {
    expect(visitorOf(request('1.1.1.1, 2.2.2.2,203.0.113.7'), 0)).toBe('203.0.113.7');
    expect(visitorOf(request('198.51.100.1, 203.0.113.7'), 0)).toBe(
      visitorOf(request('203.0.113.7'), 0),
    );
  });

  test('behind a Google HTTPS load balancer, which appends the client then itself: one in', () => {
    expect(visitorOf(request('198.51.100.1, 203.0.113.7, 34.120.0.1'), 1)).toBe('203.0.113.7');
  });

  test('fewer entries than the hops, or no header: one shared key, never one a client picks', () => {
    const shared = visitorOf(request(), 0);
    expect(visitorOf(request('203.0.113.7'), 1)).toBe(shared);
    expect(visitorOf(request(''), 0)).toBe(shared);
    expect(visitorOf(request(' , '), 0)).toBe(shared);
  });
});
