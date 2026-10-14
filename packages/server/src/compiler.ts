import type { BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime';
import { compileRule } from '@shadow-home/rules';
import { DEFAULT_COMPILER_MODELS, strandsCompilers } from '@shadow-home/rules/strands';
import type { ServiceOptions } from './service.ts';

/**
 * The house-rule compiler the environment asks for. RULE_COMPILER=bedrock turns it on (three
 * Strands agents on Bedrock); RULE_COMPILER_MODELS swaps the models, comma-separated. Off, a
 * rule in words gets "needs_compiler" and only pre-compiled rules are added.
 */
export function compilerFromEnv(
  clientConfig?: BedrockRuntimeClientConfig,
): ServiceOptions['compileRule'] {
  if (process.env.RULE_COMPILER !== 'bedrock') return undefined;
  const models = process.env.RULE_COMPILER_MODELS?.split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const compilers = strandsCompilers(models?.length ? models : DEFAULT_COMPILER_MODELS, {
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(clientConfig ? { clientConfig } : {}),
  });
  return (input) => compileRule(input, compilers);
}
