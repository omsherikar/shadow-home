import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The server serves the built MCP App views, so build them before any test runs.
    globalSetup: ['./scripts/build-views.ts'],
    // Browser checks run under Playwright (npm run e2e), not Vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
