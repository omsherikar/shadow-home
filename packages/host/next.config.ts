import { join } from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { securityHeaders } from './src/headers.ts';

/** Next calls this with its phase: only `next dev` gets the development policy. */
export default function config(phase: string): NextConfig {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    // The screen is filmed for the demo; keep Next's dev badge off it.
    devIndicators: false,
    poweredByHeader: false,
    // The monorepo root, so Next traces files from the workspace's shared node_modules.
    outputFileTracingRoot: join(import.meta.dirname, '../..'),
    // The container build (packages/host/Dockerfile) ships Next's self-contained server.
    ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
    async headers() {
      return [{ source: '/:path*', headers: securityHeaders(dev) }];
    },
  };
}
