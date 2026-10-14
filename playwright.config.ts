import { defineConfig } from '@playwright/test';

/**
 * End-to-end checks on the simulated Echo Show. Each run starts its own MCP server and host on
 * spare ports, so the home starts fresh. Locally it uses the installed Chrome; set
 * PLAYWRIGHT_CHROMIUM=1 to use Playwright's own Chromium (after `npx playwright install chromium`).
 */
const SERVER = 'http://localhost:3100';
const HOST = 'http://localhost:3101';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // The dev host compiles each route on its first request, which can take several seconds.
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: HOST,
    viewport: { width: 1440, height: 1000 },
    ...(process.env.PLAYWRIGHT_CHROMIUM ? {} : { channel: 'chrome' }),
  },
  webServer: [
    {
      command: 'node packages/views/scripts/build.ts && node packages/server/src/main.ts',
      url: `${SERVER}/healthz`,
      env: { PORT: '3100', SHADOW_HOME_DEMO: '1' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx next dev -p 3101',
      cwd: 'packages/host',
      // The turn route, so the dev server has compiled it before the first test talks.
      url: `${HOST}/api/turn`,
      env: {
        MCP_SERVER_URL: `${SERVER}/mcp`,
        MOCK_MODEL: '1',
        DEMO_MODE: '1',
        DEMO_CLOCK: '1',
        SHADOW_HOME_SILENT: '1',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
