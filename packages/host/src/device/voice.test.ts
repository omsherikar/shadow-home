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

/** An audio element that plays nothing: the test says when it has its length, errs or ends. */
class FakeAudio {
  static made: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  duration = Number.NaN;
  paused = true;
  constructor(readonly src: string) {
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

/** The voice module fresh, with every clip arriving (or, `stalled`, never) and FakeAudio to play it. */
async function voiceWithAudio(stalled = false) {
  vi.resetModules();
  FakeAudio.made = [];
  const fetch = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        if (!stalled) resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      }),
  );
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('Audio', FakeAudio);
  const voice = await import('./voice.ts');
  const speaking: boolean[] = [];
  voice.speech.watch((on) => speaking.push(on));
  return { ...voice, fetch, speaking };
}

/** Lets the clips arrive and the next one start. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('a clip that never finishes properly still counts as finished', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('how long a clip may play: its length and a margin, or 10 s while unknown', async () => {
    const { playLimitMs } = await import('./voice.ts');
    expect(playLimitMs(3)).toBe(5000);
    expect(playLimitMs(0.1)).toBe(2100);
    expect(playLimitMs(Number.NaN)).toBe(10_000);
    expect(playLimitMs(Number.POSITIVE_INFINITY)).toBe(10_000);
  });

  test('a clip that errs: the next sentence plays, and she stops speaking at the end', async () => {
    const { speak, speaking } = await voiceWithAudio();
    let result: boolean | undefined;
    void speak('Blocked: that breaks 4 house rules. Shall I fix it?').then((r) => {
      result = r;
    });
    await flush();
    FakeAudio.made[0]?.onerror?.();
    await flush();
    expect(FakeAudio.made).toHaveLength(2);
    FakeAudio.made[1]?.onended?.();
    await flush();
    // Over, but not all of it heard.
    expect(result).toBe(false);
    expect(speaking).toEqual([true, false]);
  });

  test('a clip that never ends, its length unknown, counts as over after 10 s', async () => {
    const { speak, speaking } = await voiceWithAudio();
    let result: boolean | undefined;
    void speak('Shall I fix it?').then((r) => {
      result = r;
    });
    await flush();
    expect(speaking).toEqual([true]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    expect(speaking).toEqual([true, false]);
    expect(FakeAudio.made[0]?.paused).toBe(true);
  });

  test('a clip of known length that never ends counts as over its length and a margin after it started', async () => {
    const { speak } = await voiceWithAudio();
    let result: boolean | undefined;
    void speak('Shall I fix it?').then((r) => {
      result = r;
    });
    await flush();
    const clip = FakeAudio.made[0];
    if (!clip) throw new Error('no clip');
    clip.duration = 3;
    clip.onloadedmetadata?.();
    clip.onplaying?.();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
  });

  test('playback that starts 3 s after its length is known is not cut short', async () => {
    const { speak } = await voiceWithAudio();
    let result: boolean | undefined;
    void speak('Shall I fix it?').then((r) => {
      result = r;
    });
    await flush();
    const clip = FakeAudio.made[0];
    if (!clip) throw new Error('no clip');
    clip.duration = 3;
    clip.onloadedmetadata?.();
    // The audio device takes 3 s to wake; then the 3 s clip plays to its end.
    await vi.advanceTimersByTimeAsync(3_000);
    clip.onplaying?.();
    await vi.advanceTimersByTimeAsync(2_900);
    expect(result).toBeUndefined();
    clip.onended?.();
    await flush();
    expect(result).toBe(true);
  });
});
