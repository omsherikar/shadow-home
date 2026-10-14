import type { BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime';
import { compileRule } from '@shadow-home/rules';
import { strandsCompilers } from '@shadow-home/rules/strands';
import type { ServiceOptions } from './service.ts';

/**
 * The house-rule compiler the environment asks for. RULE_COMPILER turns it on: "anthropic" (the
 * Anthropic API, key in ANTHROPIC_API_KEY) or "bedrock", three Strands agents that must agree.
 * RULE_COMPILER_MODELS swaps the models, comma-separated. Off, a rule in words gets
 * "needs_compiler" and only pre-compiled rules are added.
 */
export function compilerFromEnv(
  bedrockConfig?: BedrockRuntimeClientConfig,
): ServiceOptions['compileRule'] {
  const provider = process.env.RULE_COMPILER;
  if (provider !== 'anthropic' && provider !== 'bedrock') return undefined;
  const models = process.env.RULE_COMPILER_MODELS?.split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const compilers = strandsCompilers(models, {
    provider,
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(provider === 'bedrock' && bedrockConfig ? { clientConfig: bedrockConfig } : {}),
  });
  return (input) => compileRule(input, compilers);
}
