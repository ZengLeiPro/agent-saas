import { defineConfig } from 'playwright/test';

const baseURL = process.env.STAGING_WEB_URL;
if (!baseURL || new URL(baseURL).hostname !== 'staging.agent.kaiyan.net') {
  throw new Error('STAGING_WEB_URL must be the fixed Staging Web domain');
}

export default defineConfig({
  testDir: './staging',
  timeout: 10 * 60_000,
  expect: { timeout: 3 * 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['json', { outputFile: 'test-results/staging-results.json' }],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL,
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'mobile-chromium',
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true },
    },
  ],
});
