import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import type { Converse } from './bedrock.ts';

/** Set where AWS hands the code its own credentials: Lambda, Amplify Hosting compute, containers. */
const IN_AWS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_EXECUTION_ENV',
  'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
];

/**
 * One region for everything (docs/plan.md). On a laptop, the profile `aws login` signed in; where
 * AWS provides credentials (a deployed role), those, since naming a profile would hide them.
 */
const config = () => {
  const inAws = IN_AWS.some((name) => process.env[name]);
  const profile = process.env.AWS_PROFILE ?? (inAws ? undefined : 'shadow-home');
  return { region: process.env.AWS_REGION ?? 'us-east-1', ...(profile ? { profile } : {}) };
};

let bedrock: BedrockRuntimeClient | undefined;
let polly: PollyClient | undefined;

/**
 * Converse on Bedrock, unstreamed: it tells `onEvent` nothing, so a turn's words go out in one
 * piece when it ends. `signal` aborts the request.
 */
export function bedrockConverse(): Converse {
  bedrock ??= new BedrockRuntimeClient(config());
  const client = bedrock;
  return (input, options) =>
    client.send(new ConverseCommand(input), { abortSignal: options?.signal });
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
