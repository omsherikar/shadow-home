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
    withDeadline((input) => compileRule(input, compilers)),
    hourlyLimit(perHour('RULE_COMPILES_PER_HOUR', 10)),
  );
}

type Compile = NonNullable<ServiceOptions['compileRule']>;

/**
 * How long a rule compile may take. The three compiles run at once and usually take 5 to 9 s
 * (decision 79); one model call may take 20 s and retry once. The host waits 45 s for
 * add_house_rule, so it always hears this answer.
 */
export const COMPILE_DEADLINE_MS = 40_000;

/**
 * A compiler that gives up after `ms`. The outcome is a failed compile, as when a model can't be
 * reached, so the person hears "I couldn't work out that rule just now" and no rule is added. The
 * compiles still running are left behind, and what they decide is never used.
 */
export function withDeadline(compile: Compile, ms = COMPILE_DEADLINE_MS): Compile {
  return (input) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<CompileOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: 'failed', problems: [`No answer within ${ms / 1000} s.`] }),
        ms,
      );
    });
    return Promise.race([compile(input), late]).finally(() => clearTimeout(timer));
  };
}

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
