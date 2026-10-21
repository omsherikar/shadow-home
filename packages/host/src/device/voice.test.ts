import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** The voice module fresh, with /api/speak answering each request with the next status. */
async function voiceAnswering(...statuses: number[]) {
  vi.resetModules();
  const fetch = vi.fn(async () => new Response(null, { status: statuses.shift() ?? 200 }));
  vi.stubGlobal('fetch', fetch);
  const { speak } = await import('./voice.ts');
  return { speak, fetch };
}

describe("when the device's voice is refused", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  test('a 429 (this visitor has spoken enough this hour): the browser says that line only', async () => {
    const { speak, fetch } = await voiceAnswering(429, 429);
    await speak('Done: TV off.');
    await speak('Done: lights off.');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('a 503 (no voice, or the instance has spoken enough): the browser for the session', async () => {
    const { speak, fetch } = await voiceAnswering(503, 429);
    await speak('Done: TV off.');
    await speak('Done: lights off.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('a reply with several sentences', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  test('asks /api/speak for each sentence, in order, so each is counted on its own', async () => {
    const { speak, fetch } = await voiceAnswering(200, 200, 200);
    await speak("Blocked: that breaks 4 house rules. That's Om's rule. Shall I fix it?");
    const asked = fetch.mock.calls.map(
      (c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).text,
    );
    expect(asked).toEqual([
      'Blocked: that breaks 4 house rules.',
      "That's Om's rule.",
      'Shall I fix it?',
    ]);
  });

  test('a refused sentence leaves the rest of the reply to the browser', async () => {
    const { speak, fetch } = await voiceAnswering(200, 429, 200);
    await speak("Blocked: that breaks 4 house rules. That's Om's rule. Shall I fix it?");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
