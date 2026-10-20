import { createHash } from 'node:crypto';

/**
 * Spoken audio kept in memory, so a line said again ("Done.", a refusal, every demo line) costs
 * nothing. Bounded by total bytes (default 20 MB) and by entries (default 500): an MP3 of the
 * longest real line is about 10 seconds, some 160 kB. The least recently used goes first, and one
 * clip larger than the whole cache isn't kept.
 */
export function audioCache(options: { maxBytes?: number; maxEntries?: number } = {}) {
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 500;
  // A Map keeps insertion order; each hit is put back at the end, so the least recent is first.
  const kept = new Map<string, Uint8Array>();
  let bytes = 0;
  return {
    get(key: string): Uint8Array | undefined {
      const audio = kept.get(key);
      if (audio) {
        kept.delete(key);
        kept.set(key, audio);
      }
      return audio;
    },
    set(key: string, audio: Uint8Array): void {
      if (audio.length > maxBytes) return;
      const old = kept.get(key);
      if (old) {
        kept.delete(key);
        bytes -= old.length;
      }
      kept.set(key, audio);
      bytes += audio.length;
      while (bytes > maxBytes || kept.size > maxEntries) {
        const [oldest, clip] = kept.entries().next().value as [string, Uint8Array];
        kept.delete(oldest);
        bytes -= clip.length;
      }
    },
    /** How much is kept, for tests. */
    get size() {
      return { entries: kept.size, bytes };
    },
  };
}

/** A cached clip's key: the voice (provider, voice and model) and the words, hashed. */
export function cacheKey(voice: string, text: string): string {
  return createHash('sha256').update(voice).update('\u0000').update(text).digest('hex');
}

export type Refusal = 'visitor' | 'instance';

/**
 * Text to audio for one visitor. The same voice saying the same words comes from the cache and
 * spends nothing from the hour's budgets; otherwise the caps decide (hourlyCaps in limit.ts), then
 * the voice speaks and the clip is kept.
 */
export function speaker(options: {
  synthesize: (text: string) => Promise<Uint8Array>;
  voice: () => string;
  caps: (visitor: string, amount: number) => 'ok' | Refusal;
  cache?: ReturnType<typeof audioCache>;
}) {
  const cache = options.cache ?? audioCache();
  return async (
    visitor: string,
    text: string,
  ): Promise<{ audio: Uint8Array; cached: boolean } | { refused: Refusal }> => {
    const key = cacheKey(options.voice(), text);
    const hit = cache.get(key);
    if (hit) return { audio: hit, cached: true };
    const verdict = options.caps(visitor, text.length);
    if (verdict !== 'ok') return { refused: verdict };
    const audio = await options.synthesize(text);
    cache.set(key, audio);
    return { audio, cached: false };
  };
}
