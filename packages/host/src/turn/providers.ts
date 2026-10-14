import { type Converse, DEFAULT_MODEL_ID } from './bedrock.ts';

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
