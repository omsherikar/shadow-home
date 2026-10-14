import { describe, expect, test } from 'vitest';
import { ELEVENLABS_MODEL_ID, ELEVENLABS_VOICE_ID, elevenLabsSpeech } from './elevenlabs.ts';

/** ElevenLabs' text-to-speech endpoint, answering with the given status and bytes. */
function fakeFetch(status: number, bytes: number[] = []) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(new Uint8Array(bytes), { status });
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

describe('the ElevenLabs voice', () => {
  test('asks for an MP3 of the words in the stock voice, and returns its bytes', async () => {
    const { sent, fetch } = fakeFetch(200, [1, 2, 3]);
    const audio = await elevenLabsSpeech('Safe: TV off.', { apiKey: 'k', fetch });
    expect([...audio]).toEqual([1, 2, 3]);
    expect(sent[0]?.url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
    );
    expect(new Headers(sent[0]?.init.headers).get('xi-api-key')).toBe('k');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      text: 'Safe: TV off.',
      model_id: ELEVENLABS_MODEL_ID,
    });
  });

  test('another voice when asked', async () => {
    const { sent, fetch } = fakeFetch(200, [1]);
    await elevenLabsSpeech('Hi', { apiKey: 'k', voiceId: 'v/1', fetch });
    expect(sent[0]?.url).toContain('/text-to-speech/v%2F1?');
  });

  test('no key, a refusal, or no audio throws, so the browser speaks instead', async () => {
    const none = fakeFetch(200, [1]);
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      await expect(elevenLabsSpeech('Hi', { fetch: none.fetch })).rejects.toThrow(
        'ELEVENLABS_API_KEY',
      );
    } finally {
      if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
    }
    expect(none.sent).toHaveLength(0);
    await expect(
      elevenLabsSpeech('Hi', { apiKey: 'k', fetch: fakeFetch(401).fetch }),
    ).rejects.toThrow('401');
    await expect(
      elevenLabsSpeech('Hi', { apiKey: 'k', fetch: fakeFetch(200).fetch }),
    ).rejects.toThrow('no audio');
  });
});
