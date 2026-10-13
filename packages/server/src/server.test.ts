import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadHome } from '@shadow-home/twin/node';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { type ManualClock, manualClock } from './clock.ts';
import { initialState } from './live-home.ts';
import {
  type CommitOutput,
  commitOutput,
  type HomeStateOutput,
  type LogOutput,
  type PreviewOutput,
  previewOutput,
  type UndoOutput,
} from './schemas.ts';
import { ShadowHomeService } from './service.ts';
import { memoryStore } from './store.ts';

const root = join(import.meta.dirname, '../../..');
const home = loadHome(join(root, 'fixtures/demo-home.json'));
const FRIDAY = Date.parse('2027-01-15T17:45:00-06:00');
const MINUTE = 60_000;

const weekend = {
  intent: "I'm away for the weekend, set the house to away.",
  requestedBy: 'om',
  presenceSchedule: [
    { from: '2027-01-15T18:00:00-06:00', to: '2027-01-17T18:00:00-06:00', presence: 'nobody' },
  ],
  planEnd: '2027-01-17T18:00:00-06:00',
  actions: [
    { device: 'thermostat_main', set: { heatingSetpointC: 10 } },
    { device: 'garage_thermostat', set: { systemMode: 'off' } },
    { group: 'all_plugs', set: { onOff: false } },
    { group: 'all_lights', set: { onOff: false } },
    { device: 'front_door_lock', set: { lockState: 'LOCKED' } },
    { device: 'back_door_lock', set: { lockState: 'LOCKED' } },
    { mode: 'away' },
  ],
};

/** A server on a free port with its own home and a clock the test moves. */
async function start() {
  const clock = manualClock(FRIDAY, Date.parse('2026-10-16T12:00:00Z'));
  const service = new ShadowHomeService({
    store: memoryStore(initialState(home)),
    clock,
    secret: 'test-secret',
  });
  const app = createApp(service);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://localhost:${port}/mcp`;
  return { clock, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function connect(url: string, era: 'legacy' | 'modern') {
  const client = new Client(
    { name: 'shadow-home-test', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError ?? false, JSON.stringify(r.content)).toBe(false);
    expect(r.content).toHaveLength(1);
    return r.structuredContent as T;
  };
  return { client, call };
}

describe.each(['legacy', 'modern'] as const)('over the %s protocol', (era) => {
  let env: Awaited<ReturnType<typeof start>>;
  let api: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    env = await start();
    api = await connect(env.url, era);
  });
  afterAll(async () => {
    await api.client.close();
    await env.close();
  });

  test('negotiates the expected protocol version', () => {
    expect(api.client.getNegotiatedProtocolVersion()).toBe(
      era === 'modern' ? '2026-07-28' : '2025-11-25',
    );
  });

  test('lists seven tools with schemas and the right annotations', async () => {
    const { tools } = await api.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      'add_house_rule',
      'approve_plan',
      'commit_plan',
      'get_activity_log',
      'get_home_state',
      'preview_plan',
      'undo',
    ]);
    for (const t of tools) {
      expect(t.inputSchema, t.name).toBeDefined();
      expect(t.outputSchema, t.name).toBeDefined();
    }
    for (const name of ['get_home_state', 'preview_plan', 'undo', 'get_activity_log']) {
      expect(byName[name]?.annotations, name).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
    }
    expect(byName.commit_plan?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.approve_plan?._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(byName.preview_plan?._meta).toEqual({
      ui: { resourceUri: 'ui://shadow-home/plan-view.html' },
    });
  });

  test('serves the plan view as an MCP App resource', async () => {
    const r = await api.client.readResource({ uri: 'ui://shadow-home/plan-view.html' });
    expect(r.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' });
  });

  test('preview, block, commit the repair, then undo just the thermostat', async () => {
    const preview = await api.call<PreviewOutput>('preview_plan', weekend);
    expect(previewOutput.parse(preview)).toBeTruthy();
    expect(preview).toMatchObject({ verdict: 'UNSAFE', tier: 'T3', kind: 'plan' });
    expect(preview.violations.map((v) => v.rule)).toEqual(['R8', 'R1', 'R2', 'R3']);
    expect(preview.repair).toMatchObject({ verdict: 'SAFE', tier: 'T1' });

    const blocked = await api.call<CommitOutput>('commit_plan', { planId: preview.planId });
    expect(commitOutput.parse(blocked)).toBeTruthy();
    expect(blocked).toMatchObject({
      status: 'refused',
      reason: 'unsafe',
      alternatives: { repairPlanId: preview.repair?.planId },
    });

    const repairId = preview.repair?.planId ?? '';
    const committed = await api.call<CommitOutput>('commit_plan', { planId: repairId });
    expect(committed.status).toBe('committed');
    expect(committed.applied.map((c) => c.target)).toContain('thermostat_main');
    expect(committed.applied.map((c) => c.target)).not.toContain('plug_garage_freezer');

    // Idempotent: the same plan ID again returns the same result and changes nothing.
    const again = await api.call<CommitOutput>('commit_plan', { planId: repairId });
    expect(again).toEqual(committed);

    const undo = await api.call<UndoOutput>('undo', {
      token: 'last',
      devices: ['thermostat_main'],
    });
    expect(undo.status).toBe('preview');
    expect(undo.preview?.diff.map((r) => `${r.target} ${r.from}→${r.to}`)).toEqual([
      'thermostat_main 10→20',
    ]);
    const undone = await api.call<CommitOutput>('commit_plan', {
      planId: undo.preview?.planId,
      confirmed: true,
    });
    expect(undone.status).toBe('committed');

    const state = await api.call<HomeStateOutput>('get_home_state', {});
    const setpoint = (id: string) => state.devices.find((d) => d.id === id)?.state.heatingSetpointC;
    expect(setpoint('thermostat_main')).toBe(20);
    expect(setpoint('garage_thermostat')).toBe(5);
    expect(state.routines.find((r) => r.id === 'coffee_at_7')?.pausedUntil).toBe(
      '2027-01-17T18:00:00-06:00',
    );

    // Undoing just the thermostat leaves the rest of the plan undoable, without the thermostat.
    const log = await api.call<LogOutput>('get_activity_log', {});
    expect(log.entries.map((e) => [e.source, e.undoable])).toEqual([
      ['plan', true],
      ['undo', true],
    ]);
    expect(log.entries[0]?.undoneBy).toBeUndefined();
    const rest = await api.call<UndoOutput>('undo', { token: log.entries[0]?.undoToken });
    const targets = rest.preview?.diff.map((r) => r.target) ?? [];
    expect(targets).toContain('garage_thermostat');
    expect(targets).not.toContain('thermostat_main');
    expect(rest.notes).toContain('Coffee at 7 resumes.');
  });
});

describe('the commit contract', () => {
  let env: Awaited<ReturnType<typeof start>>;
  let api: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    env = await start();
    api = await connect(env.url, 'legacy');
  });
  afterAll(async () => {
    await api.client.close();
    await env.close();
  });
  const dim = {
    intent: 'Dim the living room to 30 percent.',
    requestedBy: 'om',
    actions: [{ device: 'light_living', set: { brightness: 30 } }],
  };

  test('a tampered plan ID is refused', async () => {
    const p = await api.call<PreviewOutput>('preview_plan', dim);
    const [prefix, payload = '', sig = ''] = p.planId.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, x: claims.x + 3_600_000 })).toString(
      'base64url',
    );
    for (const planId of [`${prefix}.${forged}.${sig}`, `${p.planId.slice(0, -2)}xx`, 'nonsense']) {
      const r = await api.call<CommitOutput>('commit_plan', { planId });
      expect(r).toMatchObject({ status: 'refused', reason: 'tampered' });
    }
  });

  test('an expired plan ID is refused, with a fresh preview', async () => {
    const p = await api.call<PreviewOutput>('preview_plan', dim);
    env.clock.advance(5 * MINUTE + 1000);
    const r = await api.call<CommitOutput>('commit_plan', { planId: p.planId });
    expect(r).toMatchObject({ status: 'refused', reason: 'expired' });
    expect(r.freshPreview?.verdict).toBe('SAFE');
    expect(r.freshPreview?.planId).not.toBe(p.planId);
  });

  test('a plan whose home changed since the preview is refused, with a fresh preview', async () => {
    const stale = await api.call<PreviewOutput>('preview_plan', dim);
    const other = await api.call<PreviewOutput>('preview_plan', {
      intent: 'TV off',
      requestedBy: 'om',
      actions: [{ device: 'plug_tv', set: { onOff: false } }],
    });
    expect((await api.call<CommitOutput>('commit_plan', { planId: other.planId })).status).toBe(
      'committed',
    );
    const r = await api.call<CommitOutput>('commit_plan', { planId: stale.planId });
    expect(r).toMatchObject({ status: 'refused', reason: 'state_changed' });
    expect(r.freshPreview?.stateVersion).toBeGreaterThan(stale.stateVersion);
  });

  test('a time without a UTC offset is rejected at the tool boundary', async () => {
    const r = await api.client.callTool({
      name: 'preview_plan',
      arguments: { ...dim, planEnd: '2027-01-17T18:00:00' },
    });
    expect(r.isError).toBe(true);
  });

  test('switching off a smoke alarm is refused at T5', async () => {
    const p = await api.call<PreviewOutput>('preview_plan', {
      intent: 'Turn off the smoke alarm',
      actions: [{ device: 'smoke_alarm_kitchen', set: { enabled: false } }],
    });
    expect(p.tier).toBe('T5');
    const r = await api.call<CommitOutput>('commit_plan', { planId: p.planId, confirmed: true });
    expect(r).toMatchObject({ status: 'refused', reason: 'refused_by_rule' });
  });

  test('the 2 AM dishwasher needs a yes or a tap, is held until 2 AM, then runs', async () => {
    env.clock.setHomeNow(Date.parse('2027-01-15T21:30:00-06:00'));
    const p = await api.call<PreviewOutput>('preview_plan', {
      intent: "Run the dishwasher at 2 AM when power's cheap.",
      requestedBy: 'om',
      actions: [{ device: 'dishwasher', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00' }],
    });
    expect(p).toMatchObject({ verdict: 'UNPROVEN', tier: 'T4' });
    expect(p.speech.ask).toBe('Run it anyway?');

    const asked = await api.call<CommitOutput>('commit_plan', { planId: p.planId });
    expect(asked).toMatchObject({
      status: 'needs_confirmation',
      speech: { ask: 'Run it anyway?' },
    });

    const tap = await api.call<{ status: string }>('approve_plan', { planId: p.planId });
    expect(tap.status).toBe('approved');
    const committed = await api.call<CommitOutput>('commit_plan', { planId: p.planId });
    expect(committed.status).toBe('committed');
    expect(committed.applied).toEqual([]);
    expect(committed.held).toEqual([
      { target: 'dishwasher', attr: 'onOff', from: false, to: true },
    ]);

    const before = await api.call<HomeStateOutput>('get_home_state', { room: 'kitchen' });
    expect(before.scheduled).toHaveLength(1);
    env.clock.setHomeNow(Date.parse('2027-01-16T02:01:00-06:00'));
    const after = await api.call<HomeStateOutput>('get_home_state', { room: 'kitchen' });
    expect(after.scheduled).toEqual([]);
    expect(after.devices.find((d) => d.id === 'dishwasher')?.state.onOff).toBe(true);

    const log = await api.call<LogOutput>('get_activity_log', { groupBy: 'cause' });
    const group = log.groups.find(
      (g) => g.label === "Run the dishwasher at 2 AM when power's cheap.",
    );
    expect(group?.entryIds).toHaveLength(2);
    expect(log.groups.map((g) => g.label)).toContain('Good night');
  });
});

describe('house rules', () => {
  let env: Awaited<ReturnType<typeof start>>;
  let api: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    env = await start();
    api = await connect(env.url, 'modern');
  });
  afterAll(async () => {
    await api.client.close();
    await env.close();
  });

  test('a compiled rule is added, read back, and loses to the smoke rule by priority', async () => {
    const r = await api.call<Record<string, unknown>>('add_house_rule', {
      text: "Never unlock the front door after 10 PM unless I'm home.",
      author: 'om',
      rule: {
        template: 'never_when',
        priority: 'security',
        params: {
          x: { device: 'front_door_lock', attr: 'lockState', eq: 'UNLOCKED' },
          when: {
            all: [
              { time: { from: '22:00', to: '06:00' } },
              { not: { presence: { member: 'om', is: 'home' } } },
            ],
          },
        },
      },
    });
    expect(r).toMatchObject({
      status: 'added',
      ruleId: 'R13',
      readBack:
        "Never: Front door lock is unlocked, when it's between 22:00 and 06:00 and Om isn't home.",
      conflicts: [{ rule: 'R6', winner: 'R6' }],
      needsOwnerApproval: false,
      sampleDay: { verdict: 'SAFE' },
    });
  });

  test('a rule in plain words needs the compiler', async () => {
    const r = await api.call<{ status: string }>('add_house_rule', {
      text: 'Keep the porch light off after midnight.',
      author: 'maya',
    });
    expect(r.status).toBe('needs_compiler');
  });
});

test('a 2025-03-26 client (what Alexa+ sends) is served', async () => {
  const env = await start();
  try {
    const res = await fetch(env.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: { roots: {} },
          clientInfo: { name: 'alexa-like', version: '1' },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"protocolVersion":"2025-03-26"');
  } finally {
    await env.close();
  }
});

export type { ManualClock };
