/**
 * 壳路由：§5.2 F5 深链、`ready.path` 作 canonical、`navId` 回声抑制、
 * 非法 path 回落，以及 §5.5/§11.1「切走再切回保留页面与滚动位置」。
 */
import { expect, test } from 'playwright/test';

import {
  APP_ORIGIN,
  CRM_IID,
  apiCallCount,
  appFrame,
  appState,
  boot,
  historyLength,
  sendFromApp,
  shellEvents,
  waitActive,
} from './harness';

test.describe('§5.2 深链与路由', () => {
  test('F5 深链 /apps/<iid>/<path>：解析壳路径 → nonce → src → 握手 → ready.path 作 canonical → replaceState', async ({
    page,
  }) => {
    // nonce 慢 300 ms，好在握手开始前稳稳地取一次 history.length（否则会和 replaceState 抢跑）
    await boot(page, { path: `/apps/${CRM_IID}/orders?b=2&a=1`, api: { nonceDelayMs: 300 } });
    const historyBefore = await historyLength(page);

    // ① 壳路径被解析成安装实例 + 应用内路径，query 键已按 §5.2 排序
    const host = page.locator('[data-testid="app-host"]');
    await expect(host).toHaveAttribute('data-installation-id', CRM_IID);
    await expect(host).toHaveAttribute('data-app-path', '/orders?a=1&b=2');

    // ② iframe src 带上 §5.2 的三个保留参数，且落在登记 origin 上
    const frameSrc = await page
      .locator('[data-testid="app-host-frame"]')
      .getAttribute('src', { timeout: 20_000 });
    const parsed = new URL(String(frameSrc));
    expect(parsed.origin).toBe(APP_ORIGIN);
    expect(parsed.pathname).toBe('/orders');
    expect(parsed.searchParams.get('ky')).toBe('1');
    expect(parsed.searchParams.get('ky_iid')).toBe(CRM_IID);
    expect(String(parsed.searchParams.get('ky_nonce'))).toHaveLength(32);
    // 应用内自己的 query 原样带过去
    expect(parsed.searchParams.get('a')).toBe('1');
    expect(parsed.searchParams.get('b')).toBe('2');

    // ③ 握手走完
    await waitActive(page);

    // ④ `ready.path`（子端报的是 /orders）作 canonical，壳把 URL 洗成它
    await expect
      .poll(() => new URL(page.url()).pathname + new URL(page.url()).search)
      .toBe(`/apps/${CRM_IID}/orders`);
    // ⑤ 洗 URL 用的是 replaceState 不是 pushState —— 否则后退键会退回脏 URL
    expect(await historyLength(page)).toBe(historyBefore);
  });

  test('4-A-01 非法应用内路径：回落应用根 + 洗 URL + 轻提示 + 落安全事件', async ({ page }) => {
    await boot(page, { path: `/apps/${CRM_IID}/a%2fb` });

    await expect(page.locator('[data-testid="app-host-notice"]')).toContainText(
      '链接无效，已返回首页',
    );
    // 不写技术归因
    await expect(page.locator('[data-testid="app-host-notice"]')).not.toContainText('%2f');
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/apps/${CRM_IID}`);

    await expect
      .poll(async () => (await shellEvents(page)).map((item) => `${item.event}:${item.reason}`))
      .toContain('path_rejected:percent_encoded_separator');
  });

  test('§5.2 navId 回声抑制：子端自发跳转 push，壳发起的跳转回声 replace', async ({ page }) => {
    await boot(page);
    await waitActive(page);
    const frame = await appFrame(page);
    const lengthAtRoot = await historyLength(page);

    // ① 子端自己跳路由（没有 navId）→ 壳 pushState，历史多一条
    await sendFromApp(frame, {
      ns: 'ky',
      v: 1,
      type: 'route.changed',
      payload: { path: '/orders' },
    });
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/apps/${CRM_IID}/orders`);
    expect(await historyLength(page)).toBe(lengthAtRoot + 1);

    // ② 后退 → 壳发起一次 route.navigate（带 navId），子端回 route.result 并把同一个
    //    navId 原样回声在 route.changed 上。回声必须收敛成 replaceState，
    //    否则「壳发起一次导航 = 历史里多两条」，后退键行为就错了。
    const lengthBeforeEcho = await historyLength(page);
    await page.goBack();
    await expect
      .poll(async () => (await appState(frame)).counters.routeNavigate, { timeout: 20_000 })
      .toBe(1);

    const navigate = (await appState(frame)).log.find((item) => item.type === 'route.navigate');
    // 子端 `sent` 里有两条 route.changed：① 是测试在步骤 ① 手动发的（没有 navId），
    // ② 才是这次的回声。取带 navId 的那条。
    const echo = (await appState(frame)).sent.find(
      (item) => item.type === 'route.changed' && item.navId !== undefined,
    );
    expect(navigate?.navId, 'route.navigate 必须带 navId').toBeTruthy();
    expect(echo?.navId, '子端回声要原样带回同一个 navId').toBe(navigate?.navId);

    await expect.poll(() => new URL(page.url()).pathname).toBe(`/apps/${CRM_IID}`);
    expect(await historyLength(page)).toBe(lengthBeforeEcho);
  });
});

test.describe('§5.5 / §11.1 切走再切回', () => {
  test('切到 Agent 标签再切回：iframe 不重载、滚动位置保留、不重新握手', async ({ page }) => {
    await boot(page, { app: { tall: true } });
    await waitActive(page);
    const frame = await appFrame(page);

    await frame.evaluate(() => {
      window.scrollTo(0, 800);
    });
    await expect.poll(async () => (await appState(frame)).scrollY).toBe(800);
    const before = await appState(frame);
    const nonceCallsBefore = await apiCallCount(page, '/handshake/nonce');
    const verifyCallsBefore = await apiCallCount(page, '/handshake/verify');

    // 切走：壳 URL 离开 /apps/**，整块被 hidden
    await page.locator('[data-testid="demo-goto-chat"]').click();
    await expect(page.locator('[data-testid="demo-apps-pane"]')).toHaveClass(
      /(?:^|\s)hidden(?:\s|$)/u,
    );
    await expect(page.locator('[data-testid="app-host"]')).toHaveAttribute(
      'data-app-host-visible',
      'false',
    );
    // **禁止条件卸载 iframe**：隐藏期间它必须还在 DOM 里
    await expect(page.locator('[data-testid="app-host-frame"]')).toHaveCount(1);

    // 切回
    await page.locator(`[data-testid="apps-nav-${CRM_IID}"]`).click();
    await expect(page.locator('[data-testid="demo-apps-pane"]')).not.toHaveClass(
      /(?:^|\s)hidden(?:\s|$)/u,
    );
    await expect(page.locator('[data-testid="app-host"]')).toHaveAttribute(
      'data-app-host-phase',
      'active',
    );

    const after = await appState(frame);
    // 同一个文档：子端没有重载（重载会换 loadId、清空计数器）
    expect(after.loadId).toBe(before.loadId);
    expect(after.counters.initReceived).toBe(before.counters.initReceived);
    // §11.1：滚动位置保留
    expect(after.scrollY).toBe(800);
    // 没有重新握手：不多签一枚 SAT
    expect(await apiCallCount(page, '/handshake/nonce')).toBe(nonceCallsBefore);
    expect(await apiCallCount(page, '/handshake/verify')).toBe(verifyCallsBefore);
  });
});
