import { join } from 'node:path';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { type AppOptions, createApp } from './app.ts';
import { manualClock } from './clock.ts';
import { initialState } from './live-home.ts';
import { ShadowHomeService } from './service.ts';
import { memoryStore } from './store.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const service = new ShadowHomeService({
  store: memoryStore(initialState(home)),
  clock: manualClock(Date.parse(home.clock.now)),
  secret: 'unit',
});

/** The status a request to /healthz gets with this Host (and Origin). */
async function status(options: AppOptions, host: string, origin?: string) {
  const app = createApp(service, options);
  const res = await app.request('/healthz', {
    headers: { host, ...(origin ? { origin } : {}) },
  });
  return res.status;
}

test('answers /health, which Cloud Run passes through, as it answers /healthz', async () => {
  const app = createApp(service);
  for (const path of ['/health', '/healthz']) {
    const res = await app.request(path, { headers: { host: 'localhost:3000' } });
    expect(res.status, path).toBe(200);
    expect(await res.json(), path).toEqual({ ok: true });
  }
});

describe('which requests the app accepts', () => {
  test("by default, only localhost: a rebinding page can't reach a local server", async () => {
    expect(await status({}, 'localhost:3000')).toBe(200);
    expect(await status({}, 'attacker.example')).toBe(403);
  });

  test('with allowed hosts, only those (a Lambda Function URL)', async () => {
    const options = { allowedHosts: ['abc.lambda-url.us-east-1.on.aws'] };
    expect(await status(options, 'abc.lambda-url.us-east-1.on.aws')).toBe(200);
    expect(await status(options, 'attacker.example')).toBe(403);
  });

  test('behind a platform that routes by Host, any Host, and still only local Origins', async () => {
    const options = { anyHost: true };
    const host = 'shadow-home-mcp-123456.us-central1.run.app';
    expect(await status(options, host)).toBe(200);
    expect(await status(options, host, 'http://localhost:6274')).toBe(200);
    expect(await status(options, host, 'https://attacker.example')).toBe(403);
  });

  test('allowed hosts win over any Host', async () => {
    const options = { anyHost: true, allowedHosts: ['mcp.example.com'] };
    expect(await status(options, 'mcp.example.com')).toBe(200);
    expect(await status(options, 'shadow-home-mcp-123456.us-central1.run.app')).toBe(403);
  });
});
