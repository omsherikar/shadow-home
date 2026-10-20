import { type Converse, DEFAULT_MODEL_ID } from './bedrock.ts';
import { ELEVENLABS_MODEL_ID, ELEVENLABS_VOICE_ID } from './elevenlabs.ts';

/**
 * The model behind a live turn: the Anthropic API, or Bedrock with MODEL_PROVIDER=bedrock. Each
 * SDK loads only when it's used, so the scripted model starts fast.
 */
export async function liveModel(): Promise<{ converse: Converse; modelId: string }> {
  if (process.env.MODEL_PROVIDER === 'bedrock') {
    const { bedrockConverse } = await import('./aws.ts');
    return {
      converse: bedrockConverse(),
      modelId: process.env.BEDROCK_MODEL_ID ?? DEFAULT_MODEL_ID,
    };
  }
  const { anthropicConverse, ANTHROPIC_MODEL_ID } = await import('./anthropic.ts');
  return {
    converse: anthropicConverse(),
    modelId: process.env.ANTHROPIC_MODEL_ID ?? ANTHROPIC_MODEL_ID,
  };
}

/** The device's voice: ElevenLabs, or Amazon Polly with SPEECH=polly. */
export async function synthesize(text: string): Promise<Uint8Array> {
  if (process.env.SPEECH === 'polly') return (await import('./aws.ts')).synthesize(text);
  return (await import('./elevenlabs.ts')).elevenLabsSpeech(text);
}

/** The voice that speaks, with its provider and model, so a cached clip is reused only for it. */
export function voiceName(): string {
  if (process.env.SPEECH === 'polly')
    return `polly:${process.env.POLLY_VOICE ?? 'Danielle'}:neural`;
  return `elevenlabs:${process.env.ELEVENLABS_VOICE_ID ?? ELEVENLABS_VOICE_ID}:${ELEVENLABS_MODEL_ID}`;
}
