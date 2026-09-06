/**
 * 会话与实例状态：§5.5 401 单飞续期、§5.4 `token.refresh.error` 四个 reason 的壳侧处置，
 * 以及 §5.5/§6.6「`live` 失败/停用 → 标签保留『暂不可用』」（Phase B 补丁的行为，防回归）。
 */
import { expect, test } from 'playwright/test';

import { CRM_IID, WMS_IID, apiCallCount, appFrame, appState, boot, waitActive } from './harness';

test.describe('§5.5 401 续期', () => {
  test('并发三条 token.request 只打一次续期端点（单飞），三条都拿到同一枚新 SAT', async ({
    page,
  }) => {
    await boot(page, { api: { tokenDelayMs: 500 } });
    await waitActive(page);
    const frame = await appFrame(page, 'ky_nonce');
    const initToken = (
      (await appState(frame)).log.find((item) => item.type === 'init')?.payload as { token: string }
    ).token;

    // 三条**同时**发出（不同 id，都需要应答）—— 单飞要挡的就是这种并发
    await frame.evaluate(() => {
      const api = (window as unknown as { __ky: { send: (m: unknown) => void } }).__ky;
      for (const id of ['tr-1', 'tr-2', 'tr-3']) {
        api.send({ ns: 'ky', v: 1, type: 'token.request', id });
      }
    });

    await expect
      .poll(
        async () =>
          (await appState(frame)).log.filter((item) => item.type === 'token.refresh').length,
      )
      .toBe(3);
    expect(await apiCallCount(page, '/token'), '并发续期只该打一次端点').toBe(1);

    const tokens = (await appState(frame)).log
      .filter((item) => item.type === 'token.refresh')
      .map((item) => (item.payload as { token: string }).token);
    expect(new Set(tokens).size, '三条应答必须是同一枚令牌').toBe(1);
    expect(tokens[0]).not.toBe(initToken);
  });

  test('reason=temporary：壳保持现状不把用户踢走，交子端指数退避', async ({ page }) => {
    await boot(page, { api: { tokenError: { status: 503, code: 'unavailable' } } });
    await waitActive(page);
    const frame = await appFrame(page, 'ky_nonce');

    await frame.evaluate(() => {
      (window as unknown as { __ky: { send: (m: unknown) => void } }).__ky.send({
        ns: 'ky',
        v: 1,
        type: 'token.request',
        id: 'tr-temp',
      });
    });

    await expect
      .poll(async () => (await appState(frame)).log.at(-1)?.type)
      .toBe('token.refresh.error');
    expect((await appState(frame)).log.at(-1)?.payload).toEqual({ reason: 'temporary' });
    // 仍然停在 active：临时故障不该把页面换成错误页
    await expect(page.locator('[data-testid="app-host"]')).toHaveAttribute(
      'data-app-host-phase',
      'active',
    );
    await expect(page.locator('[data-testid="app-host-failure"]')).toHaveCount(0);
  });

  test('reason=session_expired：壳停下来并显示「登录状态已过期，请重新登录」', async ({ page }) => {
    await boot(page, { api: { tokenError: { status: 401 } } });
    await waitActive(page);
    const frame = await appFrame(page, 'ky_nonce');

    await frame.evaluate(() => {
      (window as unknown as { __ky: { send: (m: unknown) => void } }).__ky.send({
        ns: 'ky',
        v: 1,
        type: 'token.request',
        id: 'tr-expired',
      });
    });

    // 终止性 reason 会卸掉 iframe，所以只在壳这一侧断言
    await expect(page.locator('[data-testid="app-host-failure"]')).toContainText(
      '登录状态已过期，请重新登录',
    );
    await expect(page.locator('[data-testid="app-host-retry"]')).toHaveCount(0);
  });

  test('reason=installation_disabled：壳显示《系统名》暂不可用', async ({ page }) => {
    await boot(page, { api: { tokenError: { status: 403, code: 'installation_disabled' } } });
    await waitActive(page);
    const frame = await appFrame(page, 'ky_nonce');

    await frame.evaluate(() => {
      (window as unknown as { __ky: { send: (m: unknown) => void } }).__ky.send({
        ns: 'ky',
        v: 1,
        type: 'token.request',
        id: 'tr-disabled',
      });
    });

    await expect(page.locator('[data-testid="app-host-failure"]')).toContainText(
      '《客户管理》暂不可用',
    );
  });
});

test.describe('§5.5 / §6.6 停用态', () => {
  test('系统停用：侧边栏标签保留并标「暂不可用」，进入后有说法，且完全不发握手请求', async ({
    page,
  }) => {
    await boot(page, { scenario: 'disabled' });

    // 标签**不消失**（曾经的实现是整项从侧边栏摘掉，那是规范违反）
    const tab = page.locator(`[data-testid="apps-nav-${CRM_IID}"]`);
    await expect(tab).toBeVisible();
    await expect(tab).toContainText('客户管理');
    await expect(tab).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator(`[data-testid="apps-nav-mark-${CRM_IID}"]`)).toContainText(
      '暂不可用',
    );
    // 另一个正常系统不受影响
    await expect(page.locator(`[data-testid="apps-nav-${WMS_IID}"]`)).toBeVisible();

    // 进入后给出《系统名》的说法，不给重试（§6.6「系统被停用」那一行）
    await expect(page.locator('[data-testid="app-host-failure"]')).toContainText(
      '《客户管理》暂不可用',
    );
    await expect(page.locator('[data-testid="app-host-retry"]')).toHaveCount(0);

    // 准入在壳侧就断掉：不生成 nonce、不签 SAT、不挂 iframe
    expect(await apiCallCount(page, '/handshake/nonce')).toBe(0);
    expect(await apiCallCount(page, '/handshake/verify')).toBe(0);
    await expect(page.locator('[data-testid="app-host-frame"]')).toHaveCount(0);
  });
});
