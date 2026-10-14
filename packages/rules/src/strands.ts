import type { ClientOptions } from '@anthropic-ai/sdk';
import type { BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime';
import { Agent, BedrockModel, type Model } from '@strands-agents/sdk';
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import { type Compile, compileAnswerSchema } from './compile.ts';
import { compilerPrompt } from './prompt.ts';

/**
 * Three different models, so a rule is kept only when its meaning doesn't depend on which model
 * read it. On the Anthropic API, or on Bedrock as cross-region inference profiles in us-east-1.
 */
export const COMPILER_MODELS = {
  anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
  bedrock: [
    'us.anthropic.claude-sonnet-4-6',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'us.anthropic.claude-opus-4-6-v1',
  ],
} satisfies Record<string, string[]>;

export type CompilerProvider = keyof typeof COMPILER_MODELS;

export interface StrandsCompilerOptions {
  modelId: string;
  /** Where the model runs (default: the Anthropic API). */
  provider?: CompilerProvider;
  region?: string;
  /** The Bedrock client's settings: credentials, or a stand-in request handler in tests. */
  clientConfig?: BedrockRuntimeClientConfig;
  /** The Anthropic client's settings: the key (else ANTHROPIC_API_KEY), or a stand-in fetch. */
  anthropicConfig?: ClientOptions;
}

/**
 * A compiler on Strands: an agent with no tools whose answer must match the compile schema.
 * Strands sends the schema to the model as a tool and retries with the validation error when an
 * answer doesn't fit it.
 */
export function strandsCompiler(options: StrandsCompilerOptions): Compile {
  return async ({ text, author, home }) => {
    const agent = new Agent({
      model: modelFor(options),
      systemPrompt: compilerPrompt(home),
      structuredOutputSchema: compileAnswerSchema,
      printer: false,
    });
    const name = home.household.members.find((m) => m.id === author)?.name ?? author;
    const result = await agent.invoke(`${name} says: "${text}"`);
    return result.structuredOutput;
  };
}

function modelFor(options: StrandsCompilerOptions): Model {
  // Three run at once inside one server call; a stuck one mustn't hold the rule for long.
  const timeout = 20_000;
  if (options.provider === 'bedrock') {
    return new BedrockModel({
      modelId: options.modelId,
      region: options.region ?? 'us-east-1',
      temperature: 0,
      maxTokens: 2048,
      // One reply, not a stream: a compile is short and nothing is waiting on partial output.
      stream: false,
      requestTimeout: timeout,
      ...(options.clientConfig ? { clientConfig: options.clientConfig } : {}),
    });
  }
  const key = options.anthropicConfig?.apiKey;
  const apiKey = typeof key === 'string' ? key : undefined;
  return new AnthropicModel({
    modelId: options.modelId,
    // No temperature: the current Claude models refuse it (deprecated). A reading that varies run
    // to run can only make the three disagree, never let a rule through.
    maxTokens: 2048,
    // Strands looks for the key here, then in ANTHROPIC_API_KEY.
    ...(apiKey ? { apiKey } : {}),
    clientConfig: { timeout, maxRetries: 1, ...options.anthropicConfig },
  });
}

/** The compilers for the given model IDs (default: the provider's three in COMPILER_MODELS). */
export function strandsCompilers(
  modelIds: string[] | undefined,
  rest: Omit<StrandsCompilerOptions, 'modelId'> = {},
): Compile[] {
  const ids = modelIds?.length ? modelIds : COMPILER_MODELS[rest.provider ?? 'anthropic'];
  return ids.map((modelId) => strandsCompiler({ ...rest, modelId }));
}
