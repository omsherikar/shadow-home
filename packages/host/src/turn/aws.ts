import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import type { Converse } from './bedrock.ts';

/**
 * One region for everything (docs/plan.md). Locally, the profile `aws login` signed in; where
 * credentials come from the environment (a deployed role), those, since a profile would hide them.
 */
const config = () => {
  const profile =
    process.env.AWS_PROFILE ?? (process.env.AWS_ACCESS_KEY_ID ? undefined : 'shadow-home');
  return { region: process.env.AWS_REGION ?? 'us-east-1', ...(profile ? { profile } : {}) };
};

let bedrock: BedrockRuntimeClient | undefined;
let polly: PollyClient | undefined;

export function bedrockConverse(): Converse {
  bedrock ??= new BedrockRuntimeClient(config());
  const client = bedrock;
  return (input) => client.send(new ConverseCommand(input));
}

/** Speech as MP3 from Polly's neural engine. Throws if Polly isn't available to the account. */
export async function synthesize(text: string): Promise<Uint8Array> {
  polly ??= new PollyClient(config());
  const out = await polly.send(
    new SynthesizeSpeechCommand({
      Engine: 'neural',
      VoiceId: (process.env.POLLY_VOICE ?? 'Danielle') as never,
      OutputFormat: 'mp3',
      Text: text,
    }),
  );
  if (!out.AudioStream) throw new Error('Polly returned no audio');
  return out.AudioStream.transformToByteArray();
}
