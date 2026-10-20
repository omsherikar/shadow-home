import { describe, expect, test } from 'vitest';
import { audioCache, cacheKey, speaker } from './speech.ts';

const clip = (n: number) => new Uint8Array(n);

/** A speaker over a stand-in voice that counts what it speaks and what the caps were asked. */
function setup(voice = 'elevenlabs:v1:flash', refuse?: 'visitor' | 'instance') {
  const spoken: string[] = [];
  const charged: number[] = [];
  const speak = speaker({
    synthesize: async (text) => {
      spoken.push(text);
      return clip(text.length * 100);
    },
    voice: () => voice,
    caps: (_visitor, amount) => {
      charged.push(amount);
      return refuse ?? 'ok';
    },
  });
  return { speak, spoken, charged };
}

describe('spoken audio', () => {
  test('a line said again comes from the cache, and spends nothing', async () => {
    const { speak, spoken, charged } = setup();
    expect(await speak('a', 'Done: TV off.')).toMatchObject({ cached: false });
    expect(await speak('b', 'Done: TV off.')).toMatchObject({ cached: true });
    expect(spoken).toEqual(['Done: TV off.']);
    expect(charged).toEqual([13]);
  });

  test('different words, or another voice, are a miss', async () => {
    expect(cacheKey('elevenlabs:v1:flash', 'Done.')).not.toBe(cacheKey('polly:Danielle', 'Done.'));
    const { speak, spoken } = setup();
    await speak('a', 'Done.');
    await speak('a', 'Done!');
    expect(spoken).toEqual(['Done.', 'Done!']);
  });

  test('a refusal by the caps is passed on; nothing is spoken or kept', async () => {
    const { speak, spoken } = setup(undefined, 'visitor');
    expect(await speak('a', 'Done.')).toEqual({ refused: 'visitor' });
    expect(spoken).toEqual([]);
  });

  test('bounded by bytes and by entries, the least recently used out first', () => {
    const cache = audioCache({ maxBytes: 300, maxEntries: 3 });
    cache.set('a', clip(100));
    cache.set('b', clip(100));
    cache.set('c', clip(100));
    expect(cache.get('a')).toBeDefined();
    cache.set('d', clip(100));
    // b was the least recently used: a was just heard.
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toEqual({ entries: 3, bytes: 300 });
    cache.set('e', clip(250));
    expect(cache.size).toEqual({ entries: 1, bytes: 250 });
    cache.set('huge', clip(301));
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('e')).toBeDefined();
  });
});
