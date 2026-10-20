// The MCP server on Google Cloud Run. State lives in Firestore, so every instance serves the same
// home; the plan-ID key comes from Secret Manager (Cloud Run hands it over as an environment
// variable), so a plan previewed on one instance commits on another.
//
// Environment:
//   PORT                     the port to listen on (Cloud Run sets it; default 8080)
//   SHADOW_HOME_SECRET       the plan-ID key
//   HOME_RESTART_HOUR        UTC hour the home starts over each day (default 8)
//   ALLOWED_HOSTS            Host names to accept, comma-separated; unset, any (see below)
//   RULE_COMPILER            "anthropic" or "bedrock" compiles house rules in plain words
//   FIRESTORE_COLLECTION     the collection homes are kept in (default homes)
//   FIRESTORE_EMULATOR_HOST  the Firestore emulator, for running the container on a laptop
//   GOOGLE_CLOUD_PROJECT     the project, so log lines carry their request's trace
// The Firestore client finds the project and credentials itself on Cloud Run
// (GOOGLE_CLOUD_PROJECT names the project elsewhere).
import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { compilerFromEnv } from './compiler.ts';
import { deployedHome } from './deployed.ts';
import { firestoreStore } from './firestore-store.ts';
import { log, withRequest } from './log.ts';
import { ShadowHomeService } from './service.ts';
import { stopGracefully } from './shutdown.ts';

const secret = process.env.SHADOW_HOME_SECRET;
if (!secret) throw new Error('Set SHADOW_HOME_SECRET');
const port = Number(process.env.PORT ?? 8080);
const deployed = deployedHome();

const store = firestoreStore({
  db: new Firestore(),
  collection: process.env.FIRESTORE_COLLECTION ?? 'homes',
  homeKey: deployed.homeKey,
  initial: deployed.initial,
  expiresAt: deployed.expiresAtMs,
});
const service = new ShadowHomeService({
  store,
  clock: deployed.clock,
  secret,
  compileRule: compilerFromEnv(),
});

// Cloud Run's front end only routes a request to this service if its Host is one of the
// service's own URLs (or a domain mapped to it), so the Host is checked before it gets here.
// ALLOWED_HOSTS narrows that further, say to a custom domain.
const allowedHosts = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const app = createApp(service, {
  ...(allowedHosts.length > 0 ? { allowedHosts } : { anyHost: true }),
  onError: (e) => log('ERROR', 'mcp error', { error: e.name, reason: e.message }),
});

const server = serve(
  {
    // Each request's headers stay in reach of what it logs, so its lines carry its trace.
    fetch: (req, env) => withRequest(req.headers, () => app.fetch(req, env)),
    port,
    hostname: '0.0.0.0',
  },
  (info) => log('INFO', 'ready', { port: info.port, home: deployed.homeKey() }),
);
stopGracefully(server);
