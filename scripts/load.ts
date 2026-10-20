// preview_plan under load against a running server: a fixed number of requests at each level of
// "this many at once", and the round trip each took (p50, p90, p99), as an MCP client sees it.
// Calls to the home take turns (ShadowHomeService), and one Node process uses one core, as one
// Cloud Run vCPU does, so with more at once a request mostly waits for the ones ahead of it. The
// levels show how many one instance can hold before p99 passes what a spoken reply can afford,
// which is what Cloud Run's --concurrency is set from (scripts/gcp/deploy.ts).
//
// Each level runs in several rounds, interleaved, because a shared machine is noisy: a cell is the
// median round (the lower middle one of an even number), with the lowest and highest in brackets.
//
//   node packages/server/src/main.ts      (the in-memory store; PORT picks the port)
//   node scripts/load.ts [url] [--count 200] [--levels 1,2,4,8,16,32] [--rounds 3]
//
// The url defaults to http://localhost:3000/mcp.
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { PLANS, percentile } from './measure.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    count: { type: 'string', default: '200' },
    levels: { type: 'string', default: '1,2,4,8,16,32' },
    rounds: { type: 'string', default: '3' },
  },
});
const whole = z.coerce.number().int().min(1);
const options = z
  .object({
    url: z.url().default('http://localhost:3000/mcp'),
    count: whole,
    rounds: whole,
    levels: z.string().transform((s, ctx) => {
      const levels = s.split(',').map(Number);
      if (levels.some((n) => !Number.isInteger(n) || n < 1)) {
        ctx.addIssue({ code: 'custom', message: 'levels are whole numbers, comma-separated' });
      }
      return levels;
    }),
  })
  .safeParse({ ...values, url: positionals[0] });
if (!options.success) {
  console.error(z.prettifyError(options.error));
  console.error(
    'Usage: node scripts/load.ts [url] [--count 200] [--levels 1,2,4,8,16,32] [--rounds 3]',
  );
  process.exit(1);
}
const { url, count, rounds, levels } = options.data;

/** One measured level: each request's round trip, fastest first, and requests answered a second. */
interface Run {
  times: number[];
  perSecond: number;
}

/**
 * Whether a call failed because its connection was closed: an idle one the server let go just as
 * the client reused it. A heavily loaded machine makes this race likelier.
 */
function closed(e: unknown): boolean {
  for (let c: unknown = e; c && typeof c === 'object'; c = (c as { cause?: unknown }).cause) {
    const code = (c as { code?: unknown }).code;
    if (code === 'ECONNRESET' || code === 'EPIPE') return true;
  }
  return false;
}

let resent = 0;
/** One preview_plan call, sent again once if its connection had been closed. */
async function preview(client: Client, args: Record<string, unknown>) {
  const send = () => client.callTool({ name: 'preview_plan', arguments: args });
  try {
    return await send();
  } catch (e) {
    if (!closed(e)) throw e;
    resent++;
    return send();
  }
}

/** `count` calls with `args`, `clients.length` at once: each client sends its next as one ends. */
async function run(clients: Client[], args: Record<string, unknown>): Promise<Run> {
  const times: number[] = [];
  let sent = 0;
  const start = performance.now();
  await Promise.all(
    clients.map(async (client) => {
      while (sent < count) {
        sent++;
        const t = performance.now();
        const r = await preview(client, args);
        times.push(performance.now() - t);
        if (r.isError) throw new Error(JSON.stringify(r.content));
      }
    }),
  );
  const seconds = (performance.now() - start) / 1000;
  return { times: times.sort((a, b) => a - b), perSecond: count / seconds };
}

const clients = await Promise.all(
  Array.from({ length: Math.max(...levels) }, async () => {
    const client = new Client({ name: 'load', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  }),
);

// Untimed first: the server compiles its hot paths, and each client opens its connection.
for (const args of Object.values(PLANS)) {
  for (let i = 0; i < 20; i++) await preview(clients[i % clients.length] as Client, args);
  await Promise.all(clients.map((client) => preview(client, args)));
}

const results = new Map<string, Run[]>();
const key = (plan: string, level: number) => `${plan}\u0000${level}`;
for (let round = 1; round <= rounds; round++) {
  for (const [plan, args] of Object.entries(PLANS)) {
    for (const level of levels) {
      const r = await run(clients.slice(0, level), args);
      results.set(key(plan, level), [...(results.get(key(plan, level)) ?? []), r]);
      console.error(
        `round ${round}, ${plan}, ${level} at once: p99 ${percentile(r.times, 99).toFixed(0)} ms`,
      );
    }
  }
}

const WIDTH = 22;
/** The median of the rounds' values, with the lowest and highest. */
function cell(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
  const lo = sorted[0] ?? Number.NaN;
  const hi = sorted.at(-1) ?? Number.NaN;
  const text =
    sorted.length > 1 ? `${mid.toFixed(0)} (${lo.toFixed(0)}-${hi.toFixed(0)})` : mid.toFixed(0);
  return `${text} `.padEnd(WIDTH);
}

console.log(`\n${url}, ${count} requests a level, ${rounds} round${rounds === 1 ? '' : 's'}`);
for (const plan of Object.keys(PLANS)) {
  console.log(`\n${plan}`);
  console.log(
    `${'at once'.padEnd(9)}${['p50 ms', 'p90 ms', 'p99 ms', 'per second'].map((h) => h.padEnd(WIDTH)).join('')}`,
  );
  for (const level of levels) {
    const runs = results.get(key(plan, level)) ?? [];
    const at = (p: number) => cell(runs.map((r) => percentile(r.times, p)));
    console.log(
      `${String(level).padEnd(9)}${at(50)}${at(90)}${at(99)}${cell(runs.map((r) => r.perSecond))}`,
    );
  }
}

if (resent > 0) {
  console.log(
    `\n${resent} calls went out on a connection the server had just closed and were sent again; their times include both tries.`,
  );
}
await Promise.all(clients.map((c) => c.close()));
