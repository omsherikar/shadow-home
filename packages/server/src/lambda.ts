// The MCP server on AWS Lambda, behind a Function URL. State lives in DynamoDB, so every
// instance serves the same home; the plan-ID key comes from Secrets Manager, so a plan previewed
// on one instance commits on another.
//
// Environment:
//   TABLE_NAME          the DynamoDB table (string keys pk, sk; TTL attribute expiresAt)
//   SECRET_ARN          Secrets Manager secret holding the plan-ID key, or
//   SHADOW_HOME_SECRET  the key itself (local runs)
//   HOME_RESTART_HOUR   UTC hour the home starts over each day (default 8)
//   ALLOWED_HOSTS       extra Host names to accept, comma-separated (a custom domain)
//   RULE_COMPILER       "bedrock" compiles house rules in plain words (RULE_COMPILER_MODELS)
//   DYNAMODB_ENDPOINT   DynamoDB Local, for running the bundle on a laptop
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { homeSchema, validateHome } from '@shadow-home/twin';
import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import fixture from '../../../fixtures/demo-home.json' with { type: 'json' };
import { createApp } from './app.ts';
import { dailyClock } from './clock.ts';
import { compilerFromEnv } from './compiler.ts';
import { dynamoStore } from './dynamo-store.ts';
import { initialState } from './live-home.ts';
import { ShadowHomeService } from './service.ts';

type Handler = ReturnType<typeof handle>;

const DAY_S = 24 * 60 * 60;

async function secret(): Promise<string> {
  const direct = process.env.SHADOW_HOME_SECRET;
  if (direct) return direct;
  const arn = process.env.SECRET_ARN;
  if (!arn) throw new Error('Set SECRET_ARN or SHADOW_HOME_SECRET');
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  if (!out.SecretString) throw new Error(`Secret ${arn} has no string value`);
  return out.SecretString;
}

/** The server, once per instance: the home, the clock, the store and the plan-ID key. */
async function start(): Promise<ShadowHomeService> {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('Set TABLE_NAME');
  const home = homeSchema.parse(fixture);
  const problems = validateHome(home);
  if (problems.length > 0) throw new Error(`The demo home is inconsistent: ${problems.join('; ')}`);

  const clock = dailyClock(Date.parse(home.clock.now), Number(process.env.HOME_RESTART_HOUR ?? 8));
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const client = DynamoDBDocumentClient.from(new DynamoDBClient(endpoint ? { endpoint } : {}));
  const store = dynamoStore({
    client,
    table,
    homeKey: () => `home#${clock.run()}`,
    initial: () => initialState(home),
    // A day's home is gone two days after it ends.
    expiresAt: () => Math.floor(clock.wallNowMs() / 1000) + 3 * DAY_S,
  });
  return new ShadowHomeService({
    store,
    clock,
    secret: await secret(),
    compileRule: compilerFromEnv(),
  });
}

let service: Promise<ShadowHomeService> | undefined;
/** One HTTP app per domain the instance is called on, each accepting that domain as the Host. */
const apps = new Map<string, Handler>();

export async function handler(event: LambdaEvent, context: LambdaContext) {
  service ??= start().catch((e: unknown) => {
    service = undefined;
    throw e;
  });
  // A Function URL event names the URL's own domain. Another kind of event (a console test)
  // names none, and gets an app of its own, so it can't lock the URL's requests out.
  const domain =
    (event as { requestContext?: { domainName?: string } }).requestContext?.domainName ?? '';
  let app = apps.get(domain);
  if (!app) {
    const extra = (process.env.ALLOWED_HOSTS ?? '').split(',').filter(Boolean);
    app = handle(
      createApp(await service, {
        allowedHosts: [...(domain ? [domain] : []), ...extra],
        onError: (e) => console.error('mcp:', e.message),
      }),
    );
    apps.set(domain, app);
  }
  return app(event, context);
}
