// The CDK app: one stack in us-east-1. Bundle first (npm run synth or deploy does).
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { ShadowHomeStack } from '../lib/stack.ts';

const app = new App();
new ShadowHomeStack(app, 'ShadowHome', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  bundleDir: join(import.meta.dirname, '../dist/lambda'),
});
