/**
 * WP4 定制软件壳（AppHost）的真实浏览器 E2E（规范 §9.3-10/15/16、§11.1、§14.1 WP4 DoD）。
 *
 * **为什么不复用 `e2e/playwright.config.ts`**：那份在 import 期就断言
 * `STAGING_WEB_URL` 必须是固定的 Staging 域，`globalSetup` 还会真的登录 Staging。
 * 壳侧协议要验的是「伪造 event.source」「contractVersion=2」「init.ack 丢失重发」
 * 这类对端行为，Staging 上没有可以这样摆弄的定制项目，也不该为测试去动 Staging。
 * 所以本套自带对端：`web/demo/`（生产 AppHost 源码 + 照 §5.4 写的 mock 定制项目），
 * 壳与子端分挂 `127.0.0.1` / `localhost`，真跨源、零后端、零 Staging 依赖。
 *
 * 执行方式与 `e2e/staging/**` 一致：由手动 `staging-acceptance.yml` 跑
 * （`pnpm exec playwright test -c e2e/ky-app-shell.playwright.config.ts`）。
 * 本地同一条命令即可复现，不需要任何 secrets。
 */
import { defineConfig } from 'playwright/test';

export const SHELL_ORIGIN = 'http://127.0.0.1:4190';
export const APP_ORIGIN = 'http://localhost:4191';

export default defineConfig({
  testDir: './ky-app-shell',
  testMatch: /.*\.spec\.ts/u,
  // 单条用例最长的是「init.ack 一直不回 → 5 s × 3 次重发后判失败」，约 20 s
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: '../test-results/ky-app-shell',
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/ky-app-shell-results.json' }],
    ['html', { open: 'never', outputFolder: 'playwright-report-ky-app-shell' }],
  ],
  use: {
    baseURL: SHELL_ORIGIN,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    // 演示态构建 + 两个静态服务器；不起后端、不跑 `pnpm dev`
    // `cwd` 默认就是本配置文件所在目录（`e2e/`），不要用 `import.meta` ——
    // Playwright 把配置编译成 CJS，出现 `import.meta` 会直接 ReferenceError。
    command: 'node ky-app-shell/serve.mjs',
    url: `${SHELL_ORIGIN}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'ky-app-shell',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
  ],
});
