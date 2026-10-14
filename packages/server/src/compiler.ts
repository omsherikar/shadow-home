import type { BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime';
import { type CompileOutcome, compileRule } from '@shadow-home/rules';
import { strandsCompilers } from '@shadow-home/rules/strands';
import { hourlyLimit, perHour } from './limit.ts';
import type { ServiceOptions } from './service.ts';

/**
 * The house-rule compiler the environment asks for. RULE_COMPILER turns it on: "anthropic" (the
 * Anthropic API, key in ANTHROPIC_API_KEY) or "bedrock", three Strands agents that must agree.
 * RULE_COMPILER_MODELS swaps the models, comma-separated. RULE_COMPILES_PER_HOUR (default 10)
 * caps how many rules this instance compiles in an hour, since each costs three model calls. Off,
 * a rule in words gets "needs_compiler" and only pre-compiled rules are added.
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
  return capped(
    (input) => compileRule(input, compilers),
    hourlyLimit(perHour('RULE_COMPILES_PER_HOUR', 10)),
  );
}

type Compile = NonNullable<ServiceOptions['compileRule']>;

/**
 * A compiler that refuses once the hour's allowance is used, without calling any model. The
 * refusal is a failed compile, so the person hears "I couldn't work out that rule just now."
 */
export function capped(compile: Compile, allow: () => boolean): Compile {
  return (input) =>
    allow()
      ? compile(input)
      : Promise.resolve<CompileOutcome>({
          status: 'failed',
          problems: ['The hour’s allowance of rule compiles is used up.'],
        });
}
