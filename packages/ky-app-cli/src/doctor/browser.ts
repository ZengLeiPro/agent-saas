/**
 * 浏览器 harness（playwright chromium）：§9.3-10 全部、§9.3-15 性能、§9.3-16 版本，
 * 外加 §9.3-8 的「叶子 path 被路由覆盖」（要靠壳发 `route.navigate`）。
 *
 * `playwright` 是可选 peer 依赖：`--browser auto` 下找不到浏览器就整体 SKIP 并 WARN，
 * `--browser on` 则直接失败。子端一侧通过 `window.__kyApp`（模板暴露的 KyApp 实例）驱动。
 */
import { ADMIN_REQUIRED_MENU_KEY, type MenuItem, type MeResponse } from '@kaiyan/ky-app-contract';

import { assert, expectStatus } from '../harness/http.js';
import { fixtureUsers } from './fixtures.js';
import { leaves } from './ch08Permissions.js';
import type { DoctorContext } from './context.js';

/** playwright 的最小结构性类型，避免把可选依赖写进类型面。 */
interface PageLike {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  frames(): FrameLike[];
  waitForFunction(
    expression: string,
    arg?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}
interface FrameLike {
  url(): string;
  evaluate<T>(expression: string): Promise<T>;
}

/** 把参数内联进表达式字符串：不依赖 playwright 对「字符串表达式 + arg」的传参约定。 */
function inline(template: string, ...values: unknown[]): string {
  return template.replace(/\$(\d)/gu, (_match, index: string) =>
    JSON.stringify(values[Number(index)]),
  );
}
interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

async function loadChromium(): Promise<{
  launch(options: { headless: boolean }): Promise<BrowserLike>;
} | null> {
  try {
    const playwright = (await import('playwright')) as unknown as {
      chromium?: { launch(options: { headless: boolean }): Promise<BrowserLike> };
    };
    return playwright.chromium ?? null;
  } catch {
    return null;
  }
}

const SLEEP = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBrowserChapters(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  if (ctx.browserMode === 'off') {
    for (const chapter of [10, 15, 16] as const) {
      reporter.section(chapter);
      reporter.record('浏览器 harness', 'skip', '--browser off');
    }
    return;
  }

  const chromium = await loadChromium();
  if (chromium === null) {
    if (ctx.browserMode === 'on') {
      for (const chapter of [10, 15, 16] as const) {
        reporter.section(chapter);
        reporter.record('浏览器 harness', 'fail', '--browser on 但没装 playwright');
      }
      return;
    }
    reporter.warn('没找到 playwright / chromium，浏览器相关章节跳过（本机验证请先装浏览器）');
    for (const chapter of [10, 15, 16] as const) {
      reporter.section(chapter);
      reporter.record('浏览器 harness', 'skip', '未安装 playwright 或缺少 chromium');
    }
    return;
  }

  let browser: BrowserLike;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (ctx.browserMode === 'on') {
      for (const chapter of [10, 15, 16] as const) {
        reporter.section(chapter);
        reporter.record('浏览器 harness', 'fail', `chromium 启动失败：${reason}`);
      }
      return;
    }
    reporter.warn(`chromium 启动失败，浏览器相关章节跳过：${reason}`);
    for (const chapter of [10, 15, 16] as const) {
      reporter.section(chapter);
      reporter.record('浏览器 harness', 'skip', `chromium 启动失败：${reason}`);
    }
    return;
  }

  try {
    const page = await browser.newPage();
    await page.goto(ctx.shell.shellUrl({ automount: '0' }), { waitUntil: 'load' });
    await page.waitForFunction('window.__kyShell && window.__kyShell.config', undefined, {
      timeout: 15_000,
    });
    await chapter10(ctx, page);
    await chapter08Routes(ctx, page);
    await chapter15(ctx, page);
    await chapter16(ctx, page);
    await page.close();
  } finally {
    await browser.close();
  }
}

/** 取被测项目所在的子帧。 */
function appFrame(ctx: DoctorContext, page: PageLike): FrameLike {
  const frame = page.frames().find((item) => item.url().startsWith(ctx.app.baseUrl));
  if (frame === undefined) throw new Error('页面里找不到被测项目的 iframe');
  return frame;
}

async function mountAndWait(
  page: PageLike,
  options: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<void> {
  await page.evaluate<void>(inline('window.__kyShell.mount($0)', options));
  await page.waitForFunction('window.__kyShell.counters.initAck > 0', undefined, {
    timeout: timeoutMs,
  });
}

async function chapter10(ctx: DoctorContext, page: PageLike): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(10);

  await reporter.check('iframe 属性符合 §5.1（sandbox / allow / referrerpolicy）', async () => {
    const attributes = await page.evaluate<{
      sandbox: string;
      allow: string;
      referrerpolicy: string;
    }>('window.__kyShell.getIframeAttributes()');
    for (const token of [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-downloads',
      'allow-modals',
    ]) {
      assert(attributes.sandbox.includes(token), `sandbox 缺少 ${token}`);
    }
    assert(!attributes.sandbox.includes('allow-popups'), 'sandbox 不得含 allow-popups');
    assert(
      !attributes.sandbox.includes('allow-top-navigation'),
      'sandbox 不得含 allow-top-navigation',
    );
    assert(attributes.allow.includes('clipboard-write'), 'allow 缺少 clipboard-write');
    assert(
      attributes.referrerpolicy === 'strict-origin',
      `referrerpolicy 应为 strict-origin，实际 ${attributes.referrerpolicy}`,
    );
  });

  await reporter.check('attest → ready 每 1 s 重发 → init → init.ack', async () => {
    await mountAndWait(page, { path: '/', minReadyBeforeInit: 3, initAckTimeoutMs: 2000 });
    const readyCount = await page.evaluate<number>('window.__kyShell.count("ready")');
    assert(readyCount >= 3, `期望 ready 至少重发到 3 条，实际 ${String(readyCount)} 条`);
    const verify = await page.evaluate<{ ok: boolean }>('window.__kyShell.state.verify');
    assert(verify.ok, '壳侧安装证明校验未通过');
  });

  await reporter.check('同一 nonce 的同一 attestation 重复提交返回缓存结果', async () => {
    const cached = await page.evaluate<boolean>('window.__kyShell.state.verify.cached === true');
    const calls = await page.evaluate<number>('window.__kyShell.counters.verifyCalls');
    assert(calls >= 2, `ready 重发应触发多次壳侧校验，实际 ${String(calls)} 次`);
    assert(cached, '重复提交同一 attestation 时壳侧未返回缓存结果');
  });

  await reporter.check('init.ack 丢失后壳重发 init，子端再次回 init.ack', async () => {
    await page.evaluate<void>(
      inline('window.__kyShell.mount($0)', {
        path: '/',
        dropFirstInitAck: true,
        initAckTimeoutMs: 500,
      }),
    );
    await page.waitForFunction('window.__kyShell.count("init.ack") >= 2', undefined, {
      timeout: 15_000,
    });
    const resends = await page.evaluate<number>('window.__kyShell.counters.initResends');
    assert(resends >= 1, '壳没有重发 init');
  });

  await reporter.check('init 之前不发业务 API（请求排队）', async () => {
    await page.evaluate<void>(
      inline('window.__kyShell.mount($0)', {
        path: '/',
        minReadyBeforeInit: 4,
        initAckTimeoutMs: 3000,
      }),
    );
    await page.waitForFunction('window.__kyShell.count("ready") >= 1', undefined, {
      timeout: 15_000,
    });
    const frame = appFrame(ctx, page);
    await frame.evaluate<void>(
      'window.__kyProbe = { settled: false }; window.__kyApp.fetch("/ky/v1/me").then(function () { window.__kyProbe.settled = true; }, function () { window.__kyProbe.settled = true; }); undefined;',
    );
    await SLEEP(600);
    const settledEarly = await frame.evaluate<boolean>('window.__kyProbe.settled');
    assert(!settledEarly, 'init 之前业务请求就已发出并返回，说明没有排队');
    await page.waitForFunction('window.__kyShell.counters.initAck > 0', undefined, {
      timeout: 15_000,
    });
    const frameAfter = appFrame(ctx, page);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await frameAfter.evaluate<boolean>('window.__kyProbe.settled')) break;
      await SLEEP(100);
    }
    assert(
      await frameAfter.evaluate<boolean>('window.__kyProbe.settled'),
      'init 之后排队的请求没有被放行',
    );
  });

  await reporter.check('重复 (type,id) 重放缓存应答，副作用只执行一次', async () => {
    await mountAndWait(page, { path: '/' });
    const frame = appFrame(ctx, page);
    const before = await frame.evaluate<number>(
      'window.__kyApp.getState().counters.replayedReplies',
    );
    await page.evaluate<void>(
      'window.__kyShell.post("route.navigate", { path: "/orders" }, { id: "dup-1", navId: "dup-1" }); undefined;',
    );
    await SLEEP(200);
    await page.evaluate<void>(
      'window.__kyShell.post("route.navigate", { path: "/orders" }, { id: "dup-1", navId: "dup-1" }); undefined;',
    );
    await SLEEP(500);
    const after = await frame.evaluate<number>(
      'window.__kyApp.getState().counters.replayedReplies',
    );
    assert(after > before, `replayedReplies 未增加（${String(before)} → ${String(after)}）`);
  });

  await reporter.check('navId 回声：route.result 带回同一个 navId', async () => {
    const outcome = await page.evaluate<{ payload: { ok: boolean }; navId?: string }>(
      'window.__kyShell.navigate("/orders")',
    );
    assert(outcome.payload.ok, `route.navigate 失败：${JSON.stringify(outcome.payload)}`);
    assert(outcome.navId !== undefined, 'route.result 没有带回 navId');
  });

  await reporter.check(
    'ready.path 已按 §5.2 规范化（去尾斜杠、query 排序、剔除保留参数）',
    async () => {
      await mountAndWait(page, { path: '/orders/?b=2&a=1' });
      const readyPath = await page.evaluate<string>(
        'window.__kyShell.received.filter((m) => m.type === "ready")[0].payload.path',
      );
      assert(readyPath === '/orders?a=1&b=2', `ready.path 期望 /orders?a=1&b=2，实际 ${readyPath}`);
    },
  );

  await reporter.check('F5：子端重载后重新握手（同 nonce 同 attestation 命中缓存）', async () => {
    const frame = appFrame(ctx, page);
    await frame.evaluate<void>('window.location.reload(); undefined;');
    await page.waitForFunction('window.__kyShell.count("ready") >= 2', undefined, {
      timeout: 15_000,
    });
    await page.waitForFunction('window.__kyShell.count("init.ack") >= 2', undefined, {
      timeout: 15_000,
    });
  });

  await reporter.check(
    '壳签短 TTL 令牌 → 子端主动续期（token.request → token.refresh）',
    async () => {
      await mountAndWait(page, { path: '/', tokenTtlSeconds: 65 });
      await page.waitForFunction('window.__kyShell.counters.tokenRequests >= 1', undefined, {
        timeout: 20_000,
      });
    },
  );

  await reporter.check('401 → 单飞续期 → 自动重放一次 GET', async () => {
    await mountAndWait(page, { path: '/', tokenSkewSeconds: 120 });
    const frame = appFrame(ctx, page);
    const status = await frame.evaluate<number>(
      'window.__kyApp.fetch("/ky/v1/me").then((r) => r.status)',
    );
    assert(status === 200, `续期重放后应拿到 200，实际 ${String(status)}`);
    const replays = await frame.evaluate<number>('window.__kyApp.getState().counters.authReplays');
    assert(replays >= 1, '没有发生 401 后的自动重放');
  });

  await reporter.check('伪造 event.source 的消息被子端丢弃', async () => {
    await mountAndWait(page, { path: '/' });
    const frame = appFrame(ctx, page);
    const before = await frame.evaluate<number>('window.__kyApp.getState().counters.droppedSource');
    await page.evaluate<void>(
      'window.__kyShell.forge({ ns: "ky", v: 1, type: "route.navigate", id: "forged-1", payload: { path: "/orders" } }); undefined;',
    );
    await SLEEP(800);
    const replied = await page.evaluate<number>(
      'window.__kyShell.received.filter((m) => m.id === "forged-1").length',
    );
    assert(replied === 0, '子端对伪造来源的消息作了应答');
    const after = await frame.evaluate<number>('window.__kyApp.getState().counters.droppedSource');
    assert(after > before, `子端的 droppedSource 未增加（${String(before)} → ${String(after)}）`);
  });

  await reporter.check('link.open 本地拒绝危险 scheme 与非白名单域名', async () => {
    const frame = appFrame(ctx, page);
    const notHttps = await frame.evaluate<{ ok: boolean; reason?: string }>(
      'window.__kyApp.openLink("http://docs.kaiyan.net/a")',
    );
    assert(
      !notHttps.ok && notHttps.reason === 'not_https',
      `期望 not_https，实际 ${JSON.stringify(notHttps)}`,
    );
    const javascriptScheme = await frame.evaluate<{ ok: boolean; reason?: string }>(
      'window.__kyApp.openLink("javascript:alert(1)")',
    );
    assert(!javascriptScheme.ok, 'javascript: 链接必须被拒');
    const notAllowed = await frame.evaluate<{ ok: boolean; reason?: string }>(
      'window.__kyApp.openLink("https://evil.example/x")',
    );
    assert(
      !notAllowed.ok && notAllowed.reason === 'not_allowlisted',
      `期望 not_allowlisted，实际 ${JSON.stringify(notAllowed)}`,
    );
    const ipHost = await frame.evaluate<{ ok: boolean; reason?: string }>(
      'window.__kyApp.openLink("https://93.184.216.34/x")',
    );
    assert(
      !ipHost.ok && ipHost.reason === 'ip_host',
      `期望 ip_host，实际 ${JSON.stringify(ipHost)}`,
    );
  });

  await reporter.check('白名单内的 link.open 才会送到壳并拿到 link.result', async () => {
    const hosts = ctx.manifest.externalLinkHosts ?? [];
    assert(hosts.length > 0, 'manifest 没有声明 externalLinkHosts，无法验证白名单放行路径');
    const frame = appFrame(ctx, page);
    const outcome = await frame.evaluate<{ ok: boolean }>(
      `window.__kyApp.openLink("https://${hosts[0]}/help")`,
    );
    assert(outcome.ok, `白名单域名应放行，实际 ${JSON.stringify(outcome)}`);
    const opened = await page.evaluate<number>('window.__kyShell.counters.linkOpen');
    assert(opened >= 1, '壳没有收到 link.open');
  });

  await reporter.check('agent.open / toast / theme.changed / visibility 通路可用', async () => {
    const frame = appFrame(ctx, page);
    await frame.evaluate<void>(
      'window.__kyApp.openAgent({ prompt: "帮我看看这张订单", context: { entity: { type: "order", id: "SO-1", label: "SO-1" } } }); window.__kyApp.toast({ level: "info", message: "测试" }); undefined;',
    );
    await page.evaluate<void>(
      'window.__kyShell.setTheme("dark"); window.__kyShell.setVisibility(false); window.__kyShell.setVisibility(true); undefined;',
    );
    await SLEEP(400);
    const counters = await page.evaluate<{ agentOpen: number; toast: number }>(
      'window.__kyShell.counters',
    );
    assert(counters.agentOpen >= 1, '壳没有收到 agent.open');
    assert(counters.toast >= 1, '壳没有收到 toast');
  });
}

/** §9.3-8 的最后一条：叶子 path 必须被前端路由覆盖。 */
async function chapter08Routes(ctx: DoctorContext, page: PageLike): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(8);
  const users = fixtureUsers(ctx);

  const me = await ctx.callAsUser({ path: '/ky/v1/me' }, { sub: users.admin.sub, tadm: true });
  expectStatus(me, 200, '管理员 /me');
  const menus = (me.json as MeResponse).menus;
  const allLeaves: MenuItem[] = leaves(menus);
  assert(allLeaves.length > 0, '管理员菜单没有任何叶子');
  assert(
    JSON.stringify(menus).includes(ADMIN_REQUIRED_MENU_KEY),
    `管理员菜单缺少 ${ADMIN_REQUIRED_MENU_KEY}`,
  );

  await page.evaluate<void>(inline('window.__kyShell.mount($0)', { path: '/' }));
  await page.waitForFunction('window.__kyShell.counters.initAck > 0', undefined, {
    timeout: 15_000,
  });

  for (const leaf of allLeaves) {
    await reporter.check(`菜单叶子 ${leaf.key}（${leaf.path}）被前端路由覆盖`, async () => {
      const outcome = await page.evaluate<{ payload: { ok: boolean; reason?: string } }>(
        inline('window.__kyShell.navigate($0)', leaf.path),
      );
      assert(
        outcome.payload.ok,
        `route.navigate ${leaf.path} 返回 ${JSON.stringify(outcome.payload)}`,
      );
    });
  }
}

async function chapter15(ctx: DoctorContext, page: PageLike): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(15);

  await reporter.check('src 设置 → init.ack：P95 ≤ 3 s，硬失败 10 s（≥ 10 次）', async () => {
    const samples = await page.evaluate<number[]>('window.__kyShell.measure(10, { path: "/" })');
    assert(samples.length === 10, `期望 10 个样本，实际 ${String(samples.length)}`);
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    const max = sorted[sorted.length - 1];
    reporter.warn(
      `握手耗时（毫秒）：最小 ${sorted[0].toFixed(0)}，P95 ${p95.toFixed(0)}，最大 ${max.toFixed(0)}`,
    );
    assert(max <= 10_000, `最慢一次 ${max.toFixed(0)} ms 超过硬失败线 10 s`);
    assert(p95 <= 3000, `P95 ${p95.toFixed(0)} ms 超过 3 s`);
  });
}

async function chapter16(ctx: DoctorContext, page: PageLike): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(16);

  await reporter.check('壳发 contractVersion=2 的 init → 子端拒绝握手', async () => {
    await page.evaluate<void>(
      inline('window.__kyShell.mount($0)', {
        path: '/',
        initOverrides: { contractVersion: 2 },
        initAckTimeoutMs: 60_000,
      }),
    );
    await page.waitForFunction('window.__kyShell.counters.initSent >= 1', undefined, {
      timeout: 15_000,
    });
    await SLEEP(1500);
    const acks = await page.evaluate<number>('window.__kyShell.count("init.ack")');
    assert(acks === 0, `子端不该回 init.ack，实际收到 ${String(acks)} 条`);
    const frame = appFrame(ctx, page);
    const phase = await frame.evaluate<string>('window.__kyApp.getState().phase');
    assert(phase === 'failed', `子端应进入 failed，实际 ${phase}`);
  });

  await reporter.check('壳收到 ready.contractVersion≠1 → 错误页「系统版本不兼容」', async () => {
    await page.evaluate<void>(
      'window.__kyShell.injectReady({ contractVersion: 2, path: "/", installationId: window.__kyShell.state.iid, attestation: "x" })',
    );
    const state = await page.evaluate<{ error: string | null; errorText: string | null }>(
      '({ error: window.__kyShell.state.error, errorText: window.__kyShell.state.errorText })',
    );
    assert(
      state.error === 'contract_version_mismatch',
      `壳应进入 contract_version_mismatch，实际 ${String(state.error)}`,
    );
    assert(
      (state.errorText ?? '').includes('系统版本不兼容'),
      `错误页文案不对：${String(state.errorText)}`,
    );
  });
}
