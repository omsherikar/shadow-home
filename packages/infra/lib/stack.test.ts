import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from 'vitest';
import { ShadowHomeStack } from './stack.ts';

// A stand-in bundle: the stack only needs the folder to exist.
const bundleDir = mkdtempSync(join(tmpdir(), 'shadow-home-bundle-'));
writeFileSync(join(bundleDir, 'index.mjs'), 'export const handler = () => {};');

const template = Template.fromStack(
  new ShadowHomeStack(new App(), 'Test', {
    env: { account: '123456789012', region: 'us-east-1' },
    bundleDir,
  }),
);

describe('the deployed stack', () => {
  test('one on-demand table keyed pk and sk, whose items expire', () => {
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  test('the server runs the bundle on Node 22, with the table, the plan-ID key and the rule compiler', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'server/index.handler',
      Timeout: 60,
      Environment: {
        Variables: {
          TABLE_NAME: Match.anyValue(),
          SECRET_ARN: Match.anyValue(),
          HOME_RESTART_HOUR: '8',
          RULE_COMPILER: 'bedrock',
        },
      },
    });
  });

  test('a public Function URL, as Alexa+ needs one to call', () => {
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: '*',
      FunctionUrlAuthType: 'NONE',
    });
    expect(Object.keys(template.findOutputs('McpUrl'))).toHaveLength(1);
  });

  test('Bedrock access is limited to Claude models and inference profiles', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const bedrock = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s: { Action: string | string[] }) =>
        [s.Action].flat().includes('bedrock:InvokeModel'),
      );
    expect(bedrock).toHaveLength(2);
    for (const s of bedrock) {
      expect(s.Resource).toContain('arn:aws:bedrock:*::foundation-model/anthropic.*');
      expect(s.Resource).not.toContain('*');
    }
  });

  test('the host role is for Amplify and can speak through Polly', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({ Principal: { Service: 'amplify.amazonaws.com' } })],
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'polly:SynthesizeSpeech', Resource: '*' }),
        ]),
      },
    });
  });
});
