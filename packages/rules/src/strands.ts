import type { BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime';
import { Agent, BedrockModel } from '@strands-agents/sdk';
import { type Compile, compileAnswerSchema } from './compile.ts';
import { compilerPrompt } from './prompt.ts';

/**
 * Three different models, so a rule is kept only when its meaning doesn't depend on which model
 * read it. Cross-region inference profiles in us-east-1.
 */
export const DEFAULT_COMPILER_MODELS = [
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-opus-4-6-v1',
];

export interface StrandsCompilerOptions {
  modelId: string;
  region?: string;
  /** The Bedrock client's settings: credentials, or a stand-in request handler in tests. */
  clientConfig?: BedrockRuntimeClientConfig;
}

/**
 * A compiler on Strands: an agent with no tools whose answer must match the compile schema.
 * Strands sends the schema to the model as a tool and retries with the validation error when an
 * answer doesn't fit it.
 */
export function strandsCompiler(options: StrandsCompilerOptions): Compile {
  return async ({ text, author, home }) => {
    const agent = new Agent({
      model: new BedrockModel({
        modelId: options.modelId,
        region: options.region ?? 'us-east-1',
        temperature: 0,
        maxTokens: 2048,
        // One reply, not a stream: a compile is short and nothing is waiting on partial output.
        stream: false,
        // Three run at once inside one server call; a stuck one mustn't hold the rule for long.
        requestTimeout: 20_000,
        ...(options.clientConfig ? { clientConfig: options.clientConfig } : {}),
      }),
      systemPrompt: compilerPrompt(home),
      structuredOutputSchema: compileAnswerSchema,
      printer: false,
    });
    const name = home.household.members.find((m) => m.id === author)?.name ?? author;
    const result = await agent.invoke(`${name} says: "${text}"`);
    return result.structuredOutput;
  };
}

/** The compilers for the given model IDs (default: DEFAULT_COMPILER_MODELS). */
export function strandsCompilers(
  modelIds: string[] = DEFAULT_COMPILER_MODELS,
  rest: Omit<StrandsCompilerOptions, 'modelId'> = {},
): Compile[] {
  return modelIds.map((modelId) => strandsCompiler({ ...rest, modelId }));
}
