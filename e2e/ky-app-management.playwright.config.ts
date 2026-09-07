import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: './ky-app-management',
  testMatch: /.*\.spec\.ts/u,
  timeout: 90_000,
  workers: 1,
  outputDir: '../test-results/ky-app-management',
  reporter: [['list'], ['json', { outputFile: 'test-results/ky-app-management-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4196',
    browserName: 'chromium',
    actionTimeout: 15_000,
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: 'pnpm -F server exec tsx ../e2e/ky-app-management/serve.mts',
    cwd: '..',
    url: 'http://127.0.0.1:4196',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
