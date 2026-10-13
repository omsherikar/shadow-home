// Round-trip latency of preview_plan against a running server, as an MCP client sees it.
// Usage: node scripts/latency.ts [url] [runs]   (default http://localhost:3000/mcp, 50 runs)
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.argv[2] ?? 'http://localhost:3000/mcp';
const runs = Number(process.argv[3] ?? 50);

const plans = {
  'weekend away (UNSAFE, with repairs)': {
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
  },
  'dim the living room (SAFE)': {
    intent: 'Dim the living room to 30 percent.',
    requestedBy: 'om',
    actions: [{ device: 'light_living', set: { brightness: 30 } }],
  },
};

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;

for (const era of ['2025-11-25', '2026-07-28'] as const) {
  const client = new Client(
    { name: 'latency', version: '0' },
    era === '2026-07-28' ? { versionNegotiation: { mode: { pin: era } } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  for (const [name, args] of Object.entries(plans)) {
    for (let i = 0; i < 5; i++) await client.callTool({ name: 'preview_plan', arguments: args });
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      const r = await client.callTool({ name: 'preview_plan', arguments: args });
      times.push(performance.now() - t);
      if (r.isError) throw new Error(JSON.stringify(r.content));
    }
    times.sort((a, b) => a - b);
    console.log(
      `${era}  ${name}: p50 ${pct(times, 50).toFixed(0)} ms, p99 ${pct(times, 99).toFixed(0)} ms (${runs} runs)`,
    );
  }
  await client.close();
}
