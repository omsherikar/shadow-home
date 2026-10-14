import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  Message,
  Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { spokenFrom } from './scripted.ts';
import type { Model, ModelInput, ModelStep, Remembered } from './types.ts';

/** One Converse call. The real one goes to Bedrock; tests pass their own. */
export type Converse = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;

/** An MCP tool as the model may see it. */
export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** The home as the model needs it to draft plans: IDs, names, rooms, and what each device takes. */
export interface HomeBrief {
  now: string;
  mode: string;
  devices: { id: string; name: string; room: string; state: Record<string, unknown> }[];
  routines: { id: string; name: string; at: string }[];
  presence: Record<string, string>;
}

export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const MAX_TOKENS = 1024;
const HISTORY = 30;

/**
 * Bedrock's Converse loop as a `Model`: one step per call. It returns the first tool the model
 * asks for, or, once it answers in words, the server's speech fields for what it just did (its
 * own words only when no tool spoke, such as the activity log).
 */
export function bedrockModel(options: {
  converse: Converse;
  modelId?: string;
  tools: ToolDef[];
  home: HomeBrief;
  serverInstructions?: string;
}): Model {
  const offered = new Set(options.tools.map((t) => t.name));
  return {
    async next(input: ModelInput): Promise<ModelStep> {
      const out = await options.converse({
        modelId: options.modelId ?? DEFAULT_MODEL_ID,
        system: [{ text: systemPrompt(options.home, options.serverInstructions) }],
        messages: conversation(input),
        toolConfig: { tools: toolSpecs(options.tools), toolChoice: { auto: {} } },
        inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0 },
      });
      const blocks = out.output?.message?.content ?? [];
      const use = blocks.find((b) => b.toolUse)?.toolUse;
      if (use?.name) {
        if (!offered.has(use.name)) return { say: "Sorry, I can't do that." };
        return {
          call: { name: use.name, arguments: (use.input ?? {}) as Record<string, unknown> },
        };
      }
      const last = input.thisTurn.at(-1);
      const structured = last?.result.structuredContent as Record<string, unknown> | undefined;
      if (last && hasSpeech(structured))
        return { say: spokenFrom(structured, last.result.content) };
      const words = blocks
        .map((b) => b.text ?? '')
        .join(' ')
        .trim();
      return { say: words || 'Okay.' };
    },
  };
}

function hasSpeech(structured: Record<string, unknown> | undefined): boolean {
  const speech = structured?.speech as { headline?: unknown } | undefined;
  return typeof speech?.headline === 'string';
}

/** Tools for Converse. JSON Schema as MCP gives it, without the `$schema` marker. */
export function toolSpecs(tools: ToolDef[]): Tool[] {
  return tools.map((t) => {
    const { $schema: _, ...schema } = t.inputSchema;
    return {
      toolSpec: {
        name: t.name,
        description: t.description ?? t.name,
        inputSchema: { json: schema as never },
      },
    };
  });
}

/**
 * The conversation as Converse messages: what the person said, the tools the assistant called
 * with what came back, and what it said. Older tool results are cut down to what a next step
 * needs (IDs, verdict, tier, the question asked); this turn's are whole.
 */
export function conversation(input: ModelInput): Message[] {
  const messages: Message[] = [];
  const push = (role: 'user' | 'assistant', block: ContentBlock) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content?.push(block);
    else messages.push({ role, content: [block] });
  };
  const toolTurn = (id: string, name: string, args: unknown, result: unknown, isError = false) => {
    push('assistant', { toolUse: { toolUseId: id, name, input: args as never } });
    push('user', {
      toolResult: {
        toolUseId: id,
        content: [{ json: (result ?? {}) as never }],
        ...(isError ? { status: 'error' as const } : {}),
      },
    });
  };

  input.history.slice(-HISTORY).forEach((h, i) => {
    if (h.name === 'heard') push('user', { text: String(h.arguments.text ?? '') });
    else if (h.name === 'said') push('assistant', { text: String(h.arguments.text ?? '') });
    else if (h.name === 'closed') {
      push('user', { text: '(On screen, the person closed the question without a yes.)' });
    } else if (h.by === 'screen') {
      push('user', { text: `(On screen, a tap called ${h.name}: ${brief(h)})` });
    } else toolTurn(`h${i}`, h.name, h.arguments, compact(h.structuredContent));
  });
  push('user', { text: input.screen ? `${input.screen}\n\n${input.text}` : input.text });
  input.thisTurn.forEach((c, i) => {
    const result = c.result.structuredContent ?? { text: spokenFrom(undefined, c.result.content) };
    toolTurn(`t${i}`, c.name, c.arguments, result, c.result.isError === true);
  });
  // Converse starts with the person.
  while (messages[0]?.role === 'assistant') messages.shift();
  return messages;
}

const KEEP = ['status', 'reason', 'planId', 'kind', 'verdict', 'tier', 'speech', 'undoToken'];

/** An earlier result with only what a later step can use. */
function compact(sc: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!sc) return {};
  const out: Record<string, unknown> = {};
  for (const k of KEEP) if (sc[k] !== undefined) out[k] = sc[k];
  for (const k of ['repair', 'safePart'] as const) {
    const alt = sc[k] as Record<string, unknown> | null | undefined;
    if (alt) out[k] = { planId: alt.planId, verdict: alt.verdict, tier: alt.tier };
  }
  for (const k of ['preview', 'freshPreview'] as const) {
    const p = sc[k] as Record<string, unknown> | undefined;
    if (p) out[k] = compact(p);
  }
  if (Array.isArray(sc.groups)) out.groups = sc.groups;
  return out;
}

function brief(h: Remembered): string {
  const sc = h.structuredContent ?? {};
  return [sc.status, sc.verdict, (sc.speech as { headline?: string } | undefined)?.headline]
    .filter(Boolean)
    .join(', ');
}

export function systemPrompt(home: HomeBrief, serverInstructions?: string): string {
  const devices = home.devices
    .map((d) => `- ${d.id}: ${d.name} (${d.room}); ${Object.keys(d.state).join(', ') || 'sensor'}`)
    .join('\n');
  const routines = home.routines.map((r) => `- ${r.id}: ${r.name} at ${r.at}`).join('\n');
  const offset = /([+-]\d{2}:\d{2})$/.exec(home.now)?.[1] ?? 'Z';
  return `You are Alexa on an Echo Show in the person's home. You change the home only through the Shadow Home tools, and every change is checked before it runs.

How to act:
- For any change, call preview_plan first: actions with device IDs from the list below, the person's words as intent, requestedBy as the household member speaking (om unless they say otherwise), and presenceSchedule and planEnd when they say who is away and until when.
- Write every time as ISO 8601 with the home's offset ${offset}. The home's time now is ${home.now}.
- Commit only with commit_plan and a plan ID a tool gave you. Commit a T0 or T1 preview straight away. For anything else, wait until the person answers the question in speech.ask; a yes to "Do it with ... fixes instead?" commits the repair's planId, and a yes to "Do just the safe part?" or "Do just the part I can confirm?" commits with safePartOnly: true. Pass confirmed: true only when their last words were a yes to that question. A no, or anything else, means nothing is committed.
- To undo, call undo with token "last" (and devices if they named one), then wait for a yes before committing the undo's planId.
- For a new house rule, call add_house_rule with the person's words and author.
- Use one tool at a time. When you have nothing left to call, reply in one short sentence; the screen and the server's speech fields carry the detail.

The home (mode ${home.mode}):
${devices}

Routines:
${routines}

${serverInstructions ?? ''}`.trim();
}
