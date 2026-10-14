// Checks a running Shadow Home MCP server against the contract an Alexa+ add-on relies on: the
// protocol versions, the seven tools with their annotations and schemas, the plan view resource,
// and commit_plan's refusals. Usage: node scripts/check-mcp.ts [url]
// (default http://localhost:3000/mcp). It previews and commits small plans, so the home it checks
// changes; the deployed home starts over every day.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.argv[2] ?? 'http://localhost:3000/mcp';
const results: { item: string; ok: boolean; evidence: string }[] = [];
const record = (item: string, ok: boolean, evidence: string) =>
  results.push({ item, ok, evidence });

/** One JSON-RPC call over plain HTTP, read whole whether it comes back as JSON or as one SSE event. */
interface RpcReply {
  result?: { protocolVersion?: string; tools?: unknown[] };
}

async function rpc(method: string, params: unknown, version?: string): Promise<RpcReply> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(version ? { 'mcp-protocol-version': version } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const json = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}');
  return JSON.parse(json) as RpcReply;
}

// Alexa+ sends 2025-03-26 and a plain initialize, with only `roots`.
const alexa = await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: { roots: {} },
  clientInfo: { name: 'check', version: '0' },
});
const alexaTools = await rpc('tools/list', {}, '2025-03-26');
record(
  'Alexa+ protocol (2025-03-26)',
  alexa.result?.protocolVersion === '2025-03-26' && alexaTools.result?.tools?.length === 7,
  `initialize answered ${alexa.result?.protocolVersion}; tools/list gave ${alexaTools.result?.tools?.length} tools`,
);

const EXPECTED = [
  'get_home_state',
  'preview_plan',
  'commit_plan',
  'undo',
  'get_activity_log',
  'add_house_rule',
  'approve_plan',
];

for (const era of ['2025-11-25', '2026-07-28'] as const) {
  const client = new Client(
    { name: 'check', version: '0' },
    era === '2026-07-28' ? { versionNegotiation: { mode: { pin: era } } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  record(`${era}: the seven tools`, names.join() === [...EXPECTED].sort().join(), names.join(', '));
  const missing = tools.filter((t) => !t.inputSchema || !t.outputSchema).map((t) => t.name);
  record(
    `${era}: input and output schemas`,
    missing.length === 0,
    missing.join(', ') || 'all declare both',
  );
  const ann = (n: string) => tools.find((t) => t.name === n)?.annotations ?? {};
  const readOnly = ['get_home_state', 'preview_plan', 'undo', 'get_activity_log'].filter(
    (n) => ann(n).readOnlyHint !== true || ann(n).openWorldHint !== false,
  );
  const commit = ann('commit_plan');
  record(
    `${era}: annotations`,
    readOnly.length === 0 && commit.destructiveHint === true && commit.idempotentHint === true,
    readOnly.length
      ? `not read-only and closed: ${readOnly.join(', ')}`
      : 'read-only tools closed-world; commit destructive and idempotent',
  );
  const approve = tools.find((t) => t.name === 'approve_plan')?._meta as
    | { ui?: { visibility?: string[] } }
    | undefined;
  record(
    `${era}: approve_plan visible to the app only`,
    JSON.stringify(approve?.ui?.visibility) === '["app"]',
    JSON.stringify(approve?.ui?.visibility),
  );

  // Every result carries structuredContent (the client checks it against the outputSchema) and
  // one short text line.
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string }[] | undefined)?.some((c) => c.type === 'text');
    if (!r.structuredContent || !text || r.isError) {
      throw new Error(`${name}: ${JSON.stringify(r).slice(0, 300)}`);
    }
    return r as typeof r & { structuredContent: Record<string, unknown> };
  };
  const state = await call('get_home_state', {});
  await call('get_activity_log', {});
  const dim = await call('preview_plan', {
    intent: 'Dim the living room to 30 percent.',
    requestedBy: 'om',
    actions: [{ device: 'light_living', set: { brightness: 30 } }],
  });
  record(
    `${era}: results match their schemas and carry a text line`,
    true,
    `get_home_state (${Object.keys(state.structuredContent).length} fields), get_activity_log, preview_plan (${String(dim.structuredContent.verdict)})`,
  );

  const uri = (dim._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
  const view = uri ? await client.readResource({ uri }) : undefined;
  const mime = view?.contents[0]?.mimeType;
  record(
    `${era}: plan view resource`,
    mime === 'text/html;profile=mcp-app',
    `${uri} -> ${mime}, ${String((view?.contents[0] as { text?: string } | undefined)?.text?.length ?? 0)} chars`,
  );

  // Refusals: a tampered plan ID, an UNSAFE plan, and a plan whose home changed since its preview.
  const id = String(dim.structuredContent.planId);
  const tampered = await call('commit_plan', { planId: `${id.slice(0, -2)}xx` });
  const weekend = await call('preview_plan', {
    intent: "I'm away for the weekend.",
    requestedBy: 'om',
    presenceSchedule: [
      { from: '2027-01-15T18:00:00-06:00', to: '2027-01-17T18:00:00-06:00', presence: 'nobody' },
    ],
    planEnd: '2027-01-17T18:00:00-06:00',
    actions: [{ group: 'all_plugs', set: { onOff: false } }],
  });
  const unsafe = await call('commit_plan', { planId: weekend.structuredContent.planId });
  const tv = await call('preview_plan', {
    intent: 'TV off.',
    requestedBy: 'om',
    actions: [{ device: 'plug_tv', set: { onOff: false } }],
  });
  const tvCommit = await call('commit_plan', { planId: tv.structuredContent.planId });
  const stale = await call('commit_plan', { planId: id });
  const s = ({ structuredContent: c }: { structuredContent: Record<string, unknown> }) =>
    `${String(c.status)}${c.reason ? ` (${String(c.reason)})` : ''}`;
  record(
    `${era}: commit_plan refuses what it must`,
    tampered.structuredContent.status === 'refused' &&
      unsafe.structuredContent.status !== 'committed' &&
      (tvCommit.structuredContent.status !== 'committed' ||
        stale.structuredContent.reason === 'state_changed'),
    `tampered ID: ${s(tampered)}; UNSAFE plan (${String(weekend.structuredContent.verdict)}): ${s(unsafe)}; TV off: ${s(tvCommit)}, then the earlier preview: ${s(stale)}`,
  );
  await client.close();
}

const width = Math.max(...results.map((r) => r.item.length));
for (const r of results)
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.item.padEnd(width)}  ${r.evidence}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `FAIL: ${failed[0]?.item}` : `PASS: ${results.length} checks`);
process.exitCode = failed.length ? 1 : 0;
