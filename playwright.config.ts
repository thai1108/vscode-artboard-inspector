import { defineConfig } from '@playwright/test';

// Uses the locally installed Google Chrome, so no Playwright browser download is needed.
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1400, height: 900 },
  },
});
