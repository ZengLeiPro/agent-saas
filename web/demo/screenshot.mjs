/**
 * WP4 Phase B 目视验收：构建演示态 → 两个静态服务器（真跨源）→ Playwright 截四张图。
 *
 * **不跑 `pnpm dev`**：这里只有 `vite build` 出来的静态产物 + 两个 node http 服务器，
 * 既不起后端，也不碰任何 Hand。
 *
 * 壳在 127.0.0.1:4180，子端在 localhost:4181 —— 同机不同 host，浏览器视为**真跨源**，
 * 所以 §5.3 的 origin / `event.source` 校验、§5.1 的 sandbox 都在真实条件下执行。
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDir = fileURLToPath(new URL('.', import.meta.url));
const distDir = join(demoDir, 'dist');
// 截图落在施工文档目录（仓库之外）；`WP4_SHOTS_DIR` 可覆盖。
const shotsDir =
  process.env.WP4_SHOTS_DIR ?? join(homedir(), 'workspace/admin/assets/20260906/WP4施工/截图');
const SHELL_PORT = 4180;
const APP_PORT = 4181;
const SHELL_ORIGIN = `http://127.0.0.1:${SHELL_PORT}`;
const APP_ORIGIN = `http://localhost:${APP_PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function build() {
  const result = spawnSync(
    'node',
    [
      join(demoDir, '../../node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      join(demoDir, 'vite.config.ts'),
    ],
    { stdio: 'inherit', cwd: demoDir },
  );
  if (result.status !== 0) throw new Error('演示态构建失败');
}

/** 静态服务器；`fallback` 用于 SPA 深链（`/apps/<iid>/<path>` 要能直接打开）。 */
function serve(port, root, fallback) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = join(root, decodeURIComponent(url.pathname));
    if (!existsSync(file) || url.pathname.endsWith('/')) file = join(root, fallback);
    readFile(file)
      .then((body) => {
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404).end('not found');
      });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  build();
  mkdirSync(shotsDir, { recursive: true });
  const shellServer = await serve(SHELL_PORT, distDir, 'index.html');
  const appServer = await serve(APP_PORT, distDir, 'mock-app.html');

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  async function shot(name, { path, scenario, waitFor, extra }) {
    const page = await context.newPage();
    await page.addInitScript(
      ([value, origin]) => {
        window.__demoScenario = value;
        window.__demoAppOrigin = origin;
      },
      [scenario, APP_ORIGIN],
    );
    await page.goto(`${SHELL_ORIGIN}${path}`, { waitUntil: 'load' });
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 });
    if (extra) await extra(page);
    await page.screenshot({ path: join(shotsDir, name) });
    console.log(`✓ ${name}`);
    await page.close();
  }

  try {
    await shot('01-双标签侧边栏.png', {
      path: '/',
      scenario: 'ok',
      waitFor: '[data-testid="apps-nav-tsi_crm_01"]',
    });

    await shot('02-AppHost握手成功.png', {
      path: '/apps/tsi_crm_01',
      scenario: 'ok',
      waitFor: '[data-app-host-phase="active"]',
      extra: async (page) => {
        const frame = page.frameLocator('[data-testid="app-host-frame"]');
        await frame.locator('#state').filter({ hasText: '已连接 KY Agent' }).waitFor();
      },
    });

    // §5.5/§6.6：停用**不是**标签消失。这里同时等三样东西，缺一张图就截不出来：
    // 左栏「客户管理」这一项还在、它带着「暂不可用」标注、正文给出《客户管理》暂不可用。
    await shot('03-失败态-系统停用暂不可用.png', {
      path: '/apps/tsi_crm_01',
      scenario: 'disabled',
      waitFor: '[data-testid="apps-nav-mark-tsi_crm_01"]',
      extra: async (page) => {
        await page.waitForSelector('[data-testid="apps-nav-tsi_crm_01"]');
        await page.waitForSelector('[data-testid="apps-nav-tsi_wms_01"]');
        const failure = await page
          .waitForSelector('[data-testid="app-host-failure"]')
          .then((node) => node.textContent());
        if (!failure?.includes('《客户管理》暂不可用')) {
          throw new Error(`停用态正文不是《客户管理》暂不可用，实际：${failure}`);
        }
      },
    });

    await shot('04-积分耗尽降级.png', {
      path: '/',
      scenario: 'credits',
      waitFor: '[data-testid="agent-credits-exhausted"]',
    });

    await shot('05-失败态-握手失败可重试.png', {
      path: '/apps/tsi_crm_01',
      scenario: 'handshake-failed',
      waitFor: '[data-testid="app-host-retry"]',
    });
  } finally {
    await browser.close();
    shellServer.close();
    appServer.close();
  }
  console.log(`截图已写入 ${shotsDir}`);
}

await main();
