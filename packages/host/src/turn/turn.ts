import type { HomeBrief } from './bedrock.ts';
import type { Tools } from './mcp.ts';
import { runTurn, within } from './run.ts';
import type { Model, Names, TurnRequest, TurnResponse } from './types.ts';

/** What the person hears when a turn can't be taken at all. */
export const APOLOGY = "Sorry, I can't reach my assistant model right now.";

function namesOf(home: HomeBrief): Names {
  return {
    devices: Object.fromEntries(home.devices.map((d) => [d.id, { name: d.name, room: d.room }])),
    routines: Object.fromEntries(home.routines.map((r) => [r.id, r.name])),
    members: {},
  };
}

/**
 * One whole turn: connect to the MCP server, read the home, let the model decide, close. Setting
 * up and the model's steps share the turn's `deadline` (ms since the epoch), so the person always
 * hears something before the host's own request timeout. On any failure before something ran,
 * past the deadline included, they hear the apology; `failure` says what went wrong, for the log.
 */
export async function takeTurn(
  input: TurnRequest,
  options: {
    connect: (deadline: number) => Promise<Tools>;
    model: (tools: Tools, home: HomeBrief) => Promise<Model>;
    deadline: number;
  },
): Promise<{ turn: TurnResponse & { error?: string }; failure?: unknown }> {
  const { deadline } = options;
  const left = () => deadline - Date.now();
  let tools: Tools | undefined;
  const connecting = options.connect(deadline);
  try {
    tools = await within(connecting, left());
    const home = await within(tools.homeBrief(), left());
    // Names come from the home itself, so what "the thermostat" means never depends on what the
    // browser happened to see before (a reload, a log with no names).
    const request: TurnRequest = { ...input, names: namesOf(home) };
    const model = await within(options.model(tools, home), left());
    return { turn: await runTurn(model, tools, request, { deadline }) };
  } catch (e) {
    const error = e instanceof Error ? e.name : 'Error';
    return { turn: { say: APOLOGY, calls: [], error }, failure: e };
  } finally {
    if (tools) await tools.close().catch(() => undefined);
    // A connection that only came after the deadline is closed when it does.
    else void connecting.then((late) => late.close()).catch(() => undefined);
  }
}
