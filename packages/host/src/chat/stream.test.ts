import { describe, expect, test } from 'vitest';
import { eventFrom } from './stream.ts';

describe('reading the event stream', () => {
  test('reads an error, with and without when to try again', () => {
    expect(eventFrom('error', '{"message":"Busy","retryable":true,"retryAfterMs":120000}')).toEqual(
      { type: 'error', message: 'Busy', retryable: true, retryAfterMs: 120000 },
    );
    expect(eventFrom('error', '{"message":"No","retryable":false}')).toEqual({
      type: 'error',
      message: 'No',
      retryable: false,
    });
    expect(eventFrom('error', '{"message":"Busy","retryable":true,"retryAfterMs":-1}')).toBeNull();
  });
});
