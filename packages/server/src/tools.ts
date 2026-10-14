import { McpServer } from '@modelcontextprotocol/server';
import {
  addRuleInput,
  addRuleOutput,
  approveInput,
  approveOutput,
  commitInput,
  commitOutput,
  homeStateInput,
  homeStateOutput,
  logInput,
  logOutput,
  previewInput,
  previewOutput,
  undoInput,
  undoOutput,
} from './schemas.ts';
import type { ShadowHomeService } from './service.ts';
import {
  APPROVAL_META_KEY,
  NAMES_META_KEY,
  PLAN_VIEW_MIME,
  PLAN_VIEW_URI,
  planViewHtml,
} from './view.ts';

const VERSION = '0.1.0';

/** One short line for clients that only read text, plus the structured result. */
function result<T extends Record<string, unknown>>(
  text: string,
  structured: T,
  meta?: Record<string, unknown>,
) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: structured,
    ...(meta ? { _meta: meta } : {}),
  };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
// The flat key is the older form some MCP Apps hosts still read.
const onScreen = { ui: { resourceUri: PLAN_VIEW_URI }, 'ui/resourceUri': PLAN_VIEW_URI };

/** Every plan ID in a result, wherever it sits: the plan, its repair and safe part, a fresh preview. */
function planIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) planIds(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'planId' && typeof v === 'string') out.add(v);
      else planIds(v, out);
    }
  }
  return out;
}

/** A fresh MCP server over the shared service. The HTTP handler builds one per request. */
export function buildServer(service: ShadowHomeService): McpServer {
  const server = new McpServer(
    { name: 'shadow-home', version: VERSION },
    {
      instructions:
        'Check every smart-home plan with preview_plan before doing anything. Speak from the speech fields. ' +
        'Commit only with commit_plan and the plan ID the preview returned; on T2 and T4 ask the question in speech.ask first ' +
        'and pass confirmed: true only after the person says yes.',
    },
  );

  // What the plan view needs and the model mustn't have goes in `_meta`, which the model doesn't
  // read: names to draw with, and the tokens that let a tap approve the plans on screen.
  const forScreen = async (out: unknown) => ({
    ...onScreen,
    [NAMES_META_KEY]: await service.names(),
    [APPROVAL_META_KEY]: Object.fromEntries(
      [...planIds(out)].map((id) => [id, service.approvalToken(id)]),
    ),
  });

  server.registerResource(
    'plan-view',
    PLAN_VIEW_URI,
    {
      title: 'Plan check',
      description: 'Diff and timeline for a checked plan',
      mimeType: PLAN_VIEW_MIME,
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: PLAN_VIEW_MIME, text: planViewHtml() }],
    }),
  );

  server.registerTool(
    'get_home_state',
    {
      title: 'Get home state',
      description:
        'Devices, home mode, who is home, routines and scheduled changes, and how fresh each sensor is. Optionally one room.',
      inputSchema: homeStateInput,
      outputSchema: homeStateOutput,
      annotations: readOnly,
    },
    async (input) => {
      const out = await service.getHomeState(input);
      const home = Object.values(out.presence).filter((p) => p === 'home').length;
      return result(
        `${out.now}: mode ${out.mode}, ${home} home, ${out.devices.length} devices.`,
        out,
      );
    },
  );

  server.registerTool(
    'preview_plan',
    {
      title: 'Preview a plan',
      description:
        'Check a smart-home plan on a simulation of the home before anything runs. Returns SAFE, UNSAFE or UNPROVEN, ' +
        'the confirmation tier, what changes, the broken rules, repairs and a signed plan ID for commit_plan.',
      inputSchema: previewInput,
      outputSchema: previewOutput,
      annotations: readOnly,
      _meta: onScreen,
    },
    async (input) => {
      const out = await service.previewPlan(input);
      return result(
        `${out.verdict} (${out.tier}): ${out.speech.headline}`,
        out,
        await forScreen(out),
      );
    },
  );

  server.registerTool(
    'commit_plan',
    {
      title: 'Commit a plan',
      description:
        'Apply a previewed plan by its plan ID. Refuses an expired or altered ID, a plan whose home changed since the ' +
        'preview, and anything UNSAFE. T2 and T4 need confirmed: true (the person said yes) or an on-screen approval.',
      inputSchema: commitInput,
      outputSchema: commitOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: onScreen,
    },
    async (input) => {
      const out = await service.commitPlan(input);
      return result(
        `${out.status}${out.reason ? ` (${out.reason})` : ''}: ${out.speech.headline}`,
        out,
        await forScreen(out),
      );
    },
  );

  server.registerTool(
    'undo',
    {
      title: 'Preview an undo',
      description:
        'Preview putting back what a commit changed (by undo token, or "last"), including what cannot be put back. ' +
        'Apply it with commit_plan, so an undo goes through the same checks.',
      inputSchema: undoInput,
      outputSchema: undoOutput,
      annotations: readOnly,
      _meta: onScreen,
    },
    async (input) => {
      const out = await service.undo(input);
      const head = out.preview ? `${out.preview.verdict} (${out.preview.tier}): ` : '';
      return result(`${head}${out.speech.headline}`, out, await forScreen(out));
    },
  );

  server.registerTool(
    'get_activity_log',
    {
      title: 'Get activity log',
      description:
        'What changed in the home, who or what did it, the verdict, and whether it can be undone. Grouped by cause by default.',
      inputSchema: logInput,
      outputSchema: logOutput,
      annotations: readOnly,
    },
    async (input) => {
      const out = await service.getActivityLog(input);
      const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
      const entries = n(out.entries.length, 'entry', 'entries');
      return result(`${entries} in ${n(out.groups.length, 'group', 'groups')}.`, out);
    },
  );

  server.registerTool(
    'add_house_rule',
    {
      title: 'Add a house rule',
      description:
        "Add a house rule in the person's words. The server compiles it with three different models and keeps it only " +
        'if all agree; otherwise it returns each reading and asks the person to say it again. Returns a read-back, ' +
        'conflicts with existing rules and which wins, a check of the next 24 hours against it, and whether the owner ' +
        'must approve it.',
      inputSchema: addRuleInput,
      outputSchema: addRuleOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const out = await service.addHouseRule(input);
      return result(`${out.status}: ${out.speech.headline}`, out);
    },
  );

  server.registerTool(
    'approve_plan',
    {
      title: 'Approve a plan',
      description:
        'Record an on-screen approval for a previewed plan. Only the plan view calls this, on a tap, ' +
        'with the approval token it received; without that token it is refused.',
      inputSchema: approveInput,
      outputSchema: approveOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (input) => {
      const out = await service.approvePlan(input);
      return result(`${out.status}${out.reason ? ` (${out.reason})` : ''}.`, out);
    },
  );

  return server;
}
