// Serves the bundled Lambda handler over HTTP the way a Lambda Function URL calls it, against
// DynamoDB Local, so the deployed code can be checked with MCP Inspector on a laptop.
//   docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local
//   npm run bundle -w @shadow-home/infra
//   npm run serve-lambda -w @shadow-home/infra      (http://localhost:3200/mcp)
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';

const port = Number(process.env.PORT ?? 3200);
process.env.TABLE_NAME ??= 'shadow-home-local';
process.env.DYNAMODB_ENDPOINT ??= 'http://127.0.0.1:8000';
process.env.SHADOW_HOME_SECRET ??= 'local-only-not-a-secret';
process.env.AWS_REGION ??= 'us-east-1';
// DynamoDB Local takes any credentials.
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';

const db = new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT });
try {
  await db.send(
    new CreateTableCommand({
      TableName: process.env.TABLE_NAME,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    }),
  );
  await db.send(
    new UpdateTimeToLiveCommand({
      TableName: process.env.TABLE_NAME,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }),
  );
} catch (e) {
  if (!(e instanceof ResourceInUseException)) throw e;
}

const bundle = join(import.meta.dirname, '../dist/lambda/server/index.mjs');
const { handler } = (await import(pathToFileURL(bundle).href)) as {
  handler: (event: unknown, context: unknown) => Promise<LambdaResult>;
};

interface LambdaResult {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(',') : v;
  }
  const now = new Date();
  // The Function URL event, payload version 2.0.
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    requestContext: {
      accountId: 'anonymous',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: req.method ?? 'GET',
        path: url.pathname,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: headers['user-agent'] ?? '',
      },
      requestId: randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: now.toUTCString(),
      timeEpoch: now.getTime(),
    },
    ...(body.length > 0 ? { body: body.toString('base64'), isBase64Encoded: true } : {}),
  };
  try {
    const out = await handler(event, { awsRequestId: event.requestContext.requestId });
    res.statusCode = out.statusCode;
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    for (const [k, v] of Object.entries(out.multiValueHeaders ?? {})) res.setHeader(k, v);
    if (out.cookies?.length) res.setHeader('set-cookie', out.cookies);
    res.end(out.body ? Buffer.from(out.body, out.isBase64Encoded ? 'base64' : 'utf8') : undefined);
  } catch (e) {
    console.error(e);
    res.statusCode = 502;
    res.end('The handler threw; see the log.');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Lambda bundle on http://localhost:${port}/mcp (table ${process.env.TABLE_NAME})`);
});
