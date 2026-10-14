import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The server serves the built MCP App views, so build them before any test runs.
    globalSetup: ['./scripts/build-views.ts'],
  },
});
