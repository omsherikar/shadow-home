/** ElevenLabs' low-latency model, and one of its stock voices (ELEVENLABS_VOICE_ID swaps it). */
export const ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5';
export const ELEVENLABS_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';

export interface ElevenLabsOptions {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  /** A stand-in for the network in tests. */
  fetch?: typeof fetch;
}

/**
 * Speech as one MP3 from ElevenLabs. The key comes from ELEVENLABS_API_KEY. Throws when there's
 * no key or no audio, so the device falls back to the browser's own voice.
 */
export async function elevenLabsSpeech(
  text: string,
  options: ElevenLabsOptions = {},
): Promise<Uint8Array> {
  const apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const voice = options.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? ELEVENLABS_VOICE_ID;
  const res = await (options.fetch ?? fetch)(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: options.modelId ?? ELEVENLABS_MODEL_ID }),
      // A reply that takes longer than this is better said by the browser.
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}`);
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('ElevenLabs returned no audio');
  return audio;
}
