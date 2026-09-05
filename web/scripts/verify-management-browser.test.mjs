import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

// 只读验证导航与布局；脚本不会触发任何管理写操作。

const baseUrl = process.env.MANAGEMENT_E2E_BASE_URL ?? 'http://127.0.0.1:5174';
const username = process.env.MANAGEMENT_E2E_USERNAME;
const password = process.env.MANAGEMENT_E2E_PASSWORD;
const outputDir = process.env.MANAGEMENT_E2E_OUTPUT_DIR;

if (!username || !password) {
  throw new Error('MANAGEMENT_E2E_USERNAME and MANAGEMENT_E2E_PASSWORD are required');
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const runtimeErrors = [];
page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (
    message.type() === 'error' &&
    !message.text().includes('WebSocket') &&
    !message.text().includes('Failed to load resource') &&
    !message.text().includes('加载会话列表失败')
  ) {
    runtimeErrors.push(`console: ${message.text()}`);
  }
});

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('请输入手机号或用户名').fill(username);
  await page.getByPlaceholder('请输入密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('新建会话', { exact: true }).waitFor({ timeout: 20_000 });

  const accountButton = page
    .locator('button')
    .filter({ has: page.locator('span.min-w-0.flex-1.truncate') })
    .first();
  await accountButton.click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByTestId('unified-settings-sidebar').waitFor();
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByTestId('management-shell').waitFor();
  if ((await page.locator('[data-scroll-container="true"]').count()) !== 1) {
    throw new Error('管理工作区不是单一外层滚动容器');
  }
  if ((await page.getByRole('heading', { name: '模型', exact: true }).count()) !== 1) {
    throw new Error('平台模型页标题不唯一');
  }
  await page.getByText('模型管理', { exact: true }).waitFor();
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({ path: `${outputDir}/平台配置-模型.png` });
  }

  await page.evaluate(() => {
    window.history.pushState(null, '', '/platform-console/runtime/runs');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.getByTestId('unified-analysis-sidebar').waitFor();
  await page.getByRole('button', { name: '运行追踪', exact: true }).click();
  await page.getByTestId('management-shell').waitFor();
  if ((await page.getByTestId('management-shell').getAttribute('data-surface')) !== 'analytics') {
    throw new Error('分析入口未进入统一 analytics 壳');
  }
  if (outputDir) await page.screenshot({ path: `${outputDir}/平台分析-运行追踪.png` });

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await page.context().storageState(),
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(`${baseUrl}/platform-console/runtime/runs`, { waitUntil: 'domcontentloaded' });
  await mobilePage.getByTestId('management-shell').waitFor();
  if (
    (await mobilePage.getByTestId('management-shell').count()) !== 1 ||
    (await mobilePage.locator('[data-scroll-container="true"]').count()) !== 1
  ) {
    throw new Error('移动端没有复用单一管理壳和滚动容器');
  }
  const mobileOverflow = await mobilePage
    .getByTestId('management-shell')
    .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  if (mobileOverflow) throw new Error('移动端管理壳出现页面级横向溢出');
  if (outputDir) await mobilePage.screenshot({ path: `${outputDir}/移动端-运行追踪.png` });
  await mobileContext.close();

  if (runtimeErrors.length) throw new Error(runtimeErrors.join('\n'));
  console.log(
    JSON.stringify({
      ok: true,
      mobile: true,
      route: new URL(page.url()).pathname + new URL(page.url()).search,
    }),
  );
} finally {
  await browser.close();
}
