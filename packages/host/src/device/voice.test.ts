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
});
