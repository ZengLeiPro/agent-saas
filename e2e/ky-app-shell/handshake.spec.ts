/**
 * 握手状态机：§5.4 `loading → attesting → ready(每 1 s 重发, ≤10 s) → init → active`，
 * §9.3-15 的性能口径，§9.3-16 的版本拒绝，以及「子 iframe 拿不到壳会话 JWT」。
 */
import { expect, test } from 'playwright/test';

import {
  apiCallCount,
  appFrame,
  appState,
  boot,
  handshakeMillis,
  shellEvents,
  waitActive,
} from './harness';

test.describe('§5.4 / §9.3-15 握手', () => {
  test('§9.3-15 src 设置 → init.ack ≤ 3 s（P95），任一轮不得超过硬失败线 10 s', async ({
    context,
  }) => {
    const samples: number[] = [];
    for (let round = 1; round <= 5; round += 1) {
      const page = await context.newPage();
      await boot(page);
      await waitActive(page);
      const elapsed = await handshakeMillis(page);
      // 硬失败线：§9.3-15 明写 10 s，单轮超了就是坏了，不用等 P95
      expect(elapsed, `第 ${round} 轮握手耗时 ${Math.round(elapsed)} ms`).toBeLessThan(10_000);
      samples.push(elapsed);
      await page.close();
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
    // eslint-disable-next-line no-console -- 门禁要留耗时证据，失败时只有断言消息不够复盘
    console.log(`握手耗时（ms）：${sorted.map((value) => Math.round(value)).join(', ')}`);
    expect(p95, `P95 = ${Math.round(p95)} ms`).toBeLessThanOrEqual(3000);
  });

  test('子端每 1 s 重发 ready：壳只 verify 一次，重复 ready 重放同一 init', async ({ page }) => {
    // verify 慢 2.5 s，子端在这期间会按 §5.4 的 1 s 节奏继续重发 ready
    await boot(page, { api: { verifyDelayMs: 2500 } });
    await waitActive(page);
    const frame = await appFrame(page);
    const state = await appState(frame);

    expect(state.counters.readySent, '子端应至少重发过 2 次 ready').toBeGreaterThanOrEqual(3);
    // 副作用（证明校验）只跑一次；重复的 ready 走重放缓存
    expect(await apiCallCount(page, '/handshake/verify')).toBe(1);
    // 每条重复 ready 都拿到了应答，不是被丢弃
    expect(state.counters.initReceived).toBeGreaterThanOrEqual(state.counters.readySent);
  });

  test('10 s 内没有合法 ready → §6.6 握手失败文案 + 重试，并落安全事件', async ({ page }) => {
    await boot(page, { app: { sendReady: false } });

    const failure = page.locator('[data-testid="app-host-failure"]');
    await expect(failure).toContainText('《客户管理》暂时无法加载，已通知技术支持', {
      timeout: 20_000,
    });
    await expect(page.locator('[data-testid="app-host-retry"]')).toBeVisible();
    // 文案纪律：不写技术归因
    await expect(failure).not.toContainText('上游');
    await expect(failure).not.toContainText('超时');

    const events = await shellEvents(page);
    expect(
      events.some((item) => item.event === 'handshake_failed' && item.reason === 'ready_timeout'),
      `实际落的事件：${JSON.stringify(events)}`,
    ).toBe(true);
  });

  test('§5.4-4 init.ack 一直不回：壳重发 init 恰好 3 次后判失败', async ({ page }) => {
    await boot(page, { app: { ackInit: false } });
    const frame = await appFrame(page);

    // 首发 1 条 + 5 s 一次的重发 3 条 = 4 条，第 4 次再超时就判失败（不再有第 5 条）
    await expect
      .poll(async () => (await appState(frame)).counters.initReceived, {
        timeout: 30_000,
        intervals: [500],
      })
      .toBe(4);
    // 判失败前把子端状态取干净：`fail()` 会把 frameSrc 置空、iframe 随之卸载，
    // 之后再 `frame.evaluate()` 必然打在已 detach 的 frame 上
    expect((await appState(frame)).counters.initAckSent).toBe(0);

    await expect(page.locator('[data-testid="app-host-failure"]')).toContainText('暂时无法加载', {
      timeout: 20_000,
    });

    const events = await shellEvents(page);
    expect(
      events.some(
        (item) => item.event === 'handshake_failed' && item.reason === 'init_ack_timeout',
      ),
    ).toBe(true);
  });

  test('§5.4-4 init.ack 迟到：前两条 init 不回，第三条回 → 仍收敛到 active', async ({ page }) => {
    await boot(page, { app: { ackInitAfter: 2 } });
    await waitActive(page);
    const frame = await appFrame(page);
    expect((await appState(frame)).counters.initReceived).toBe(3);
    // 重发的是同一份 init（幂等可重发），不是重新握手
    expect(await apiCallCount(page, '/handshake/nonce')).toBe(1);
    expect(await apiCallCount(page, '/handshake/verify')).toBe(1);
  });

  test('§9.3-16 contractVersion=2 → 壳错误页，且不去校验证明', async ({ page }) => {
    await boot(page, { app: { contractVersion: 2 } });

    const failure = page.locator('[data-testid="app-host-failure"]');
    await expect(failure).toContainText('系统版本不兼容');
    // 版本不兼容重试也没用，§6.6 不给重试按钮
    await expect(page.locator('[data-testid="app-host-retry"]')).toHaveCount(0);
    expect(await apiCallCount(page, '/handshake/verify')).toBe(0);
  });

  test('init 载荷是字段白名单：只有 SAT 与最小用户信息，没有壳会话凭据', async ({ page }) => {
    await boot(page);
    await waitActive(page);
    const frame = await appFrame(page);
    const init = (await appState(frame)).log.find((item) => item.type === 'init');
    expect(init, '子端应收到 init').toBeTruthy();

    const payload = (init?.payload ?? {}) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'contractVersion',
      'installationId',
      'locale',
      'theme',
      'token',
      'tokenExp',
      'user',
    ]);
    expect(Object.keys(payload.user as Record<string, unknown>).sort()).toEqual([
      'displayName',
      'id',
      'isTenantAdmin',
    ]);
    // 下发的必须是 SAT（act=user），不是壳会话里的任何东西
    expect(String(payload.token)).toMatch(/^demo\.sat\.token/u);
  });
});
