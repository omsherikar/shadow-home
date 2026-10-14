import type { CallToolResult } from '@modelcontextprotocol/client';
import { spokenFrom } from './scripted.ts';
import type { Model, ToolCall, TurnRequest, TurnResponse } from './types.ts';

/** The MCP side of a turn: call a tool, and say which view (if any) it declares. */
export interface ToolRunner {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  resourceUriFor(name: string): string | undefined;
}

const MAX_STEPS = 6;

/** One conversational turn: the model picks tool calls until it has something to say. */
export async function runTurn(
  model: Model,
  tools: ToolRunner,
  request: TurnRequest,
): Promise<TurnResponse> {
  const calls: ToolCall[] = [];
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const step = await model.next({ ...request, thisTurn: calls });
      if ('say' in step) return { say: step.say, calls };
      const result = await tools.callTool(step.call.name, step.call.arguments);
      const resourceUri = tools.resourceUriFor(step.call.name);
      calls.push({ ...step.call, result, ...(resourceUri ? { resourceUri } : {}) });
    }
  } catch (e) {
    // Nothing ran: the caller says it couldn't reach the model.
    if (calls.length === 0) throw e;
    // Something ran (a commit, perhaps) before the model failed: report it as it is.
  }
  return { say: lastSpoken(calls) ?? "Sorry, I couldn't finish that.", calls };
}

function lastSpoken(calls: ToolCall[]): string | undefined {
  const spoke = calls.findLast(
    (c) => (c.result.structuredContent as { speech?: unknown } | undefined)?.speech,
  );
  if (!spoke) return undefined;
  return spokenFrom(
    spoke.result.structuredContent as Record<string, unknown>,
    spoke.result.content,
  );
}
