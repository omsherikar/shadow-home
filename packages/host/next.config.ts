import { join } from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // The screen is filmed for the demo; keep Next's dev badge off it.
  devIndicators: false,
  // The monorepo root, so Next traces files from the workspace's shared node_modules.
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  // The container build (packages/host/Dockerfile) ships Next's self-contained server.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
};

export default config;
