/**
 * 壳的信任边界：§5.3 `event.origin` + `event.source` 双校验、重复 `(type,id)` 重放
 * （副作用只跑一次），§5.4 `link.open` 的准入闭集。
 *
 * 跨源是真的：壳在 `127.0.0.1`、子端在 `localhost`，所以「同源的另一个 iframe
 * 也能发出同样的 origin」这条攻击面在这里能真正复现 —— 这正是只比 origin 会被打穿的地方。
 */
import { expect, test, type Frame, type Page } from 'playwright/test';

import {
  ALLOWED_LINK_HOST,
  APP_ORIGIN,
  CRM_IID,
  apiCallCount,
  appFrame,
  appState,
  boot,
  sendFromApp,
  shellEvents,
  waitActive,
} from './harness';

/** 与真 iframe 同源、但不是 `iframe.contentWindow` 的第二个帧 —— 伪造 `event.source`。 */
async function attachForgerFrame(page: Page, nonce: string): Promise<Frame> {
  await page.evaluate(
    ([origin, value, iid]) => {
      const node = document.createElement('iframe');
      node.src = `${origin}/mock-app.html?forger=1&ky_iid=${iid}&ky_nonce=${value}`;
      node.style.width = '1px';
      node.style.height = '1px';
      document.body.appendChild(node);
    },
    [APP_ORIGIN, nonce, CRM_IID] as const,
  );
  return appFrame(page, 'forger=1');
}

function nonceOf(src: string): string {
  return String(new URL(src).searchParams.get('ky_nonce'));
}

test.describe('§5.3 来源校验', () => {
  test('伪造 event.source：同源的另一个 iframe 发合法 ready 也被拒，且不影响真帧握手', async ({
    page,
  }) => {
    await boot(page, { app: { sendReady: false } });
    const realFrame = await appFrame(page, 'ky_nonce');
    const src = String(await page.locator('[data-testid="app-host-frame"]').getAttribute('src'));

    // 伪造者拿到的是**同一个 origin、同一个 nonce**，只差 `event.source` 这一条
    const forger = await attachForgerFrame(page, nonceOf(src));
    await forger.evaluate(() => {
      (window as unknown as { __ky: { sendReady: () => void } }).__ky.sendReady();
    });

    await expect
      .poll(async () => (await shellEvents(page)).map((item) => `${item.event}:${item.reason}`))
      .toContain('message_rejected:source');
    // 没有被推进状态机：不签证明、不进 ready
    expect(await apiCallCount(page, '/handshake/verify')).toBe(0);
    await expect(page.locator('[data-testid="app-host"]')).toHaveAttribute(
      'data-app-host-phase',
      'attesting',
    );

    // 反证：这不是「什么都拒」—— 真帧发同样的 ready 就能握上
    await realFrame.evaluate(() => {
      (window as unknown as { __ky: { sendReady: () => void } }).__ky.sendReady();
    });
    await waitActive(page);
    expect(await apiCallCount(page, '/handshake/verify')).toBe(1);
  });

  test('伪造 origin：壳自己页面发出的同形信封被拒并落安全事件', async ({ page }) => {
    await boot(page, { app: { sendReady: false } });
    const src = String(await page.locator('[data-testid="app-host-frame"]').getAttribute('src'));

    await page.evaluate((nonce) => {
      window.postMessage(
        {
          ns: 'ky',
          v: 1,
          type: 'ready',
          id: `ready-${nonce}`,
          payload: {
            contractVersion: 1,
            path: '/',
            installationId: 'tsi_crm_01',
            attestation: `forged.${nonce}`,
          },
        },
        '*',
      );
    }, nonceOf(src));

    await expect
      .poll(async () => (await shellEvents(page)).map((item) => `${item.event}:${item.reason}`))
      .toContain('message_rejected:origin');
    expect(await apiCallCount(page, '/handshake/verify')).toBe(0);
  });
});

test.describe('§5.3 重复 (type,id) 重放缓存', () => {
  test('同一条 link.open 发两次：应答重放两次，确认框与新窗口各只出现一次', async ({
    page,
    context,
  }) => {
    await context.route(`https://${ALLOWED_LINK_HOST}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }),
    );
    let dialogs = 0;
    page.on('dialog', (dialog) => {
      dialogs += 1;
      void dialog.accept();
    });
    const popups: string[] = [];
    context.on('page', (opened) => popups.push(opened.url()));

    await boot(page);
    await waitActive(page);
    const frame = await appFrame(page, 'ky_nonce');

    const envelope = {
      ns: 'ky',
      v: 1,
      type: 'link.open',
      id: 'lk-1',
      payload: { url: `https://${ALLOWED_LINK_HOST}/guide` },
    };
    await sendFromApp(frame, envelope);
    await expect
      .poll(async () => (await appState(frame)).log.filter((i) => i.type === 'link.result').length)
      .toBe(1);
    await sendFromApp(frame, envelope);

    // 重复消息不是被丢弃：子端第二次也拿到了应答
    await expect
      .poll(async () => (await appState(frame)).log.filter((i) => i.type === 'link.result').length)
      .toBe(2);
    const results = (await appState(frame)).log.filter((item) => item.type === 'link.result');
    expect(results.map((item) => item.payload)).toEqual([{ ok: true }, { ok: true }]);
    // 副作用只跑一次
    expect(dialogs, '重复的 (type,id) 不该再弹一次确认框').toBe(1);
    expect(popups, '重复的 (type,id) 不该再开一个窗口').toHaveLength(1);

    // 反证：换一个 id 就是一次新的副作用
    await sendFromApp(frame, { ...envelope, id: 'lk-2' });
    await expect.poll(() => dialogs).toBe(2);
    await expect.poll(() => popups.length).toBe(2);
  });

  test('同一条 ready 发两次：verify 只打一次，init 重放两次', async ({ page }) => {
    await boot(page);
    await waitActive(page);
    const frame = await appFrame(page, 'ky_nonce');
    const before = await appState(frame);
    const firstReady = before.sent.find((item) => item.type === 'ready');
    expect(firstReady).toBeTruthy();

    await sendFromApp(frame, firstReady as never);
    await expect
      .poll(async () => (await appState(frame)).counters.initReceived)
      .toBe(before.counters.initReceived + 1);
    expect(await apiCallCount(page, '/handshake/verify')).toBe(1);
  });
});

test.describe('§5.4 link.open 准入', () => {
  const rejected = [
    { name: '非白名单 host', url: 'https://evil.example.com/x', reason: 'not_allowlisted' },
    { name: '危险 scheme（javascript:）', url: 'javascript:alert(1)', reason: 'not_https' },
    { name: '明文 http', url: `http://${ALLOWED_LINK_HOST}/guide`, reason: 'not_https' },
    { name: '带 userinfo', url: `https://a:b@${ALLOWED_LINK_HOST}/`, reason: 'userinfo' },
    { name: 'IP 字面量', url: 'https://192.168.1.10/x', reason: 'ip_host' },
    { name: '整数形式 IP', url: 'https://3232235777/x', reason: 'ip_host' },
  ];

  test('拒绝集：每一条都回 link.result{ok:false}、不弹确认框、落 link_blocked', async ({
    page,
    context,
  }) => {
    let dialogs = 0;
    page.on('dialog', (dialog) => {
      dialogs += 1;
      void dialog.accept();
    });
    const popups: string[] = [];
    context.on('page', (opened) => popups.push(opened.url()));

    await boot(page);
    await waitActive(page);
    const frame = await appFrame(page, 'ky_nonce');

    for (const [index, item] of rejected.entries()) {
      await sendFromApp(frame, {
        ns: 'ky',
        v: 1,
        type: 'link.open',
        id: `bad-${index}`,
        payload: { url: item.url },
      });
    }

    await expect
      .poll(async () => (await appState(frame)).log.filter((i) => i.type === 'link.result').length)
      .toBe(rejected.length);
    const results = (await appState(frame)).log.filter((item) => item.type === 'link.result');
    expect(results.every((item) => (item.payload as { ok: boolean }).ok === false)).toBe(true);

    const events = (await shellEvents(page))
      .filter((item) => item.event === 'link_blocked')
      .map((item) => item.reason);
    for (const item of rejected) {
      expect(events, `${item.name} 应记 ${item.reason}`).toContain(item.reason);
    }
    // 一条都不该走到「打开外部网站」这一步
    expect(dialogs).toBe(0);
    expect(popups).toHaveLength(0);
  });

  test('白名单内放行：确认框标「外部网站」并显示 host，取消则不开窗', async ({ page, context }) => {
    await context.route(`https://${ALLOWED_LINK_HOST}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }),
    );
    const messages: string[] = [];
    let accept = false;
    page.on('dialog', (dialog) => {
      messages.push(dialog.message());
      void (accept ? dialog.accept() : dialog.dismiss());
    });
    const popups: string[] = [];
    context.on('page', (opened) => popups.push(opened.url()));

    await boot(page);
    await waitActive(page);
    const frame = await appFrame(page, 'ky_nonce');

    // ① 用户点「取消」→ ok:false，且不开窗
    await sendFromApp(frame, {
      ns: 'ky',
      v: 1,
      type: 'link.open',
      id: 'ok-1',
      payload: { url: `https://${ALLOWED_LINK_HOST}/guide?a=1` },
    });
    await expect
      .poll(async () => (await appState(frame)).log.filter((i) => i.type === 'link.result').length)
      .toBe(1);
    expect(messages[0]).toBe(`即将打开外部网站：${ALLOWED_LINK_HOST}。确认继续吗？`);
    expect((await appState(frame)).log.at(-1)?.payload).toEqual({ ok: false });
    expect(popups).toHaveLength(0);

    // ② 用户点「确定」→ ok:true，开一个窗
    accept = true;
    await sendFromApp(frame, {
      ns: 'ky',
      v: 1,
      type: 'link.open',
      id: 'ok-2',
      payload: { url: `https://${ALLOWED_LINK_HOST}/guide?a=1` },
    });
    await expect.poll(() => popups.length).toBe(1);
    expect(popups[0]).toContain(ALLOWED_LINK_HOST);
    await expect
      .poll(async () => (await appState(frame)).log.filter((i) => i.type === 'link.result').length)
      .toBe(2);
    expect((await appState(frame)).log.at(-1)?.payload).toEqual({ ok: true });
  });
});
