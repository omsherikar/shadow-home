// Round-trip latency of preview_plan against a running server, as an MCP client sees it.
// Usage: node scripts/latency.ts [url] [runs]   (default http://localhost:3000/mcp, 50 runs)
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PLANS, percentile as pct } from './measure.ts';

const url = process.argv[2] ?? 'http://localhost:3000/mcp';
const runs = Number(process.argv[3] ?? 50);

for (const era of ['2025-11-25', '2026-07-28'] as const) {
  const client = new Client(
    { name: 'latency', version: '0' },
    era === '2026-07-28' ? { versionNegotiation: { mode: { pin: era } } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  for (const [name, args] of Object.entries(PLANS)) {
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
