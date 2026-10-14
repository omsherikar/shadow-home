import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import {
  Architecture,
  Code,
  FunctionUrlAuthType,
  HttpMethod,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface ShadowHomeStackProps extends StackProps {
  /** The bundled server from scripts/bundle.ts (dist/lambda). */
  bundleDir: string;
  /** UTC hour the deployed home starts over each day. Default 8. */
  homeRestartHour?: number;
}

/**
 * The deployed MCP server: one Lambda behind a public Function URL, its state in one DynamoDB
 * table, its plan-ID key in Secrets Manager. Plus the role the Echo Show host runs under on
 * Amplify Hosting, for Bedrock and Polly.
 */
export class ShadowHomeStack extends Stack {
  constructor(scope: Construct, id: string, props: ShadowHomeStackProps) {
    super(scope, id, props);

    const table = new TableV2(this, 'State', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      // Each day's home is rebuilt from the fixture, so there is nothing here worth keeping.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const planIdKey = new Secret(this, 'PlanIdKey', {
      description: 'HMAC key for Shadow Home plan IDs, shared by every server instance',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const server = new LambdaFunction(this, 'McpServer', {
      description: 'Shadow Home MCP server',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: 'server/index.handler',
      code: Code.fromAsset(props.bundleDir),
      // 1769 MB is one full vCPU: the three simulations of a preview are CPU-bound.
      memorySize: 1769,
      // A preview takes well under a second; compiling a house rule calls Bedrock three times,
      // each allowed 20 s and a retry.
      timeout: Duration.seconds(60),
      environment: {
        TABLE_NAME: table.tableName,
        SECRET_ARN: planIdKey.secretArn,
        HOME_RESTART_HOUR: String(props.homeRestartHour ?? 8),
        RULE_COMPILER: 'bedrock',
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new LogGroup(this, 'McpServerLogs', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(server);
    planIdKey.grantRead(server);
    server.addToRolePolicy(bedrockInvoke(this.account));

    // Alexa+ and any other MCP client call it directly; browsers (Inspector's web UI) need CORS.
    const url = server.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.DELETE],
        allowedHeaders: [
          'content-type',
          'accept',
          'authorization',
          'mcp-protocol-version',
          'mcp-session-id',
          'last-event-id',
        ],
        exposedHeaders: ['mcp-session-id'],
        maxAge: Duration.hours(1),
      },
    });

    // The Echo Show host runs on Amplify Hosting; its server-side code (the Bedrock loop and
    // Polly) runs under this role once it's set as the app's compute role.
    const hostRole = new Role(this, 'EchoShowHostRole', {
      assumedBy: new ServicePrincipal('amplify.amazonaws.com'),
      description: 'Lets the Shadow Home Echo Show host call Bedrock and Polly',
    });
    hostRole.addToPolicy(bedrockInvoke(this.account));
    hostRole.addToPolicy(
      new PolicyStatement({ actions: ['polly:SynthesizeSpeech'], resources: ['*'] }),
    );

    new CfnOutput(this, 'McpUrl', {
      description: 'The MCP endpoint: give this to Alexa+, MCP Inspector or the host',
      value: `${url.url}mcp`,
    });
    new CfnOutput(this, 'HostComputeRoleArn', {
      description: "Set as the Amplify app's compute role",
      value: hostRole.roleArn,
    });
    new CfnOutput(this, 'TableName', { value: table.tableName });
  }
}

/** Converse on Claude models, directly or through a cross-region inference profile. */
function bedrockInvoke(account: string): PolicyStatement {
  return new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: [
      'arn:aws:bedrock:*::foundation-model/anthropic.*',
      `arn:aws:bedrock:*:${account}:inference-profile/*`,
    ],
  });
}
