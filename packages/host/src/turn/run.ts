import type { CallToolResult } from '@modelcontextprotocol/client';
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
  for (let i = 0; i < MAX_STEPS; i++) {
    const step = await model.next({ ...request, thisTurn: calls });
    if ('say' in step) return { say: step.say, calls };
    const result = await tools.callTool(step.call.name, step.call.arguments);
    const resourceUri = tools.resourceUriFor(step.call.name);
    calls.push({ ...step.call, result, ...(resourceUri ? { resourceUri } : {}) });
  }
  return { say: "Sorry, I couldn't finish that.", calls };
}
