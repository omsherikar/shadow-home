import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { loadHome } from '@shadow-home/twin/node';
import { createApp } from './app.ts';
import { demoClock, systemClock } from './clock.ts';
import { compilerFromEnv } from './compiler.ts';
import { initialState } from './live-home.ts';
import { ShadowHomeService } from './service.ts';
import { memoryStore } from './store.ts';

const root = join(import.meta.dirname, '../../..');
const homePath = process.env.SHADOW_HOME_FIXTURE ?? join(root, 'fixtures/demo-home.json');
const port = Number(process.env.PORT ?? 3000);
const home = loadHome(homePath);

// SHADOW_HOME_DEMO=1 adds /demo controls (move home time forward, start over) for local demos.
const demo = process.env.SHADOW_HOME_DEMO === '1' ? demoClock(Date.parse(home.clock.now)) : null;
const clock = demo ?? systemClock(Date.parse(home.clock.now));

const service = new ShadowHomeService({
  store: memoryStore(initialState(home)),
  clock,
  // A fresh key each start: plan IDs from an earlier run stop working, which is what we want.
  secret: process.env.SHADOW_HOME_SECRET ?? randomBytes(32).toString('base64url'),
  // RULE_COMPILER=anthropic reads ANTHROPIC_API_KEY; =bedrock, on a laptop, uses the profile
  // `aws login` signed in.
  compileRule: compilerFromEnv({ profile: process.env.AWS_PROFILE ?? 'shadow-home' }),
});

const app = createApp(service, {
  onError: (e) => console.error('mcp:', e.message),
  ...(demo ? { demo: { clock: demo, home } } : {}),
});
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(
    `Shadow Home MCP server on http://localhost:${info.port}/mcp (home time ${home.clock.now})${demo ? ', demo controls on /demo' : ''}`,
  );
});
