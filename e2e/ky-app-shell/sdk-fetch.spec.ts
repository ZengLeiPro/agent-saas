/**
 * §9.3-10 里落在**子端 SDK** 上的两条：「`init` 前不发 API」与
 * 「401 → 单飞续期 → 只自动重放安全读请求一次」（§5.5、契约 §5.4 表）。
 *
 * **为什么这两条要单独一个 spec**：其余用例的对端是手搓信封的 `mock-app.html`，
 * 被测对象是壳。而这两条的实现在 `packages/ky-app-browser/src/fetchWrapper.ts` 与
 * `tokenManager.ts` —— 壳侧没有对应代码。所以这里换成 `sdk-app.html`：真 SDK 源码 +
 * 真 iframe + 真跨源 postMessage + 真 HTTP 401，链路整条是真的。
 * 包里的 `fetch.test.ts` 用 jsdom + 假 fetch 覆盖同一逻辑，但覆盖不到
 * 「令牌是壳经 postMessage 现签发下来的」这一段。
 *
 * 分工与纪律：本轮**不改** `packages/ky-app-browser/**`（那是 WP1 现场），只消费。
 */
import { expect, test, type APIRequestContext } from 'playwright/test';

import {
  boot,
  CRM_IID,
  SDK_APP_ORIGIN,
  sdkFrame,
  waitActive,
  apiCallCount,
  type SdkBackendCall,
  type SdkFetchResult,
} from './harness';

/** 每条用例一个 key，定制项目后端桩按 key 分桶，用例之间零共享状态。 */
function freshKey(name: string): string {
  return `${name}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
}

async function backendCalls(request: APIRequestContext, key: string): Promise<SdkBackendCall[]> {
  const response = await request.get(`${SDK_APP_ORIGIN}/__calls?key=${encodeURIComponent(key)}`);
  expect(response.ok(), '定制项目后端桩 /__calls 不可达').toBe(true);
  const body = (await response.json()) as { calls: SdkBackendCall[] };
  return body.calls;
}

test.describe('§9.3-10 子端 SDK：init 前不发 API', () => {
  test('握手未完成时发出的 app.fetch 被排队：init 之前后端一条请求都没收到，init 之后才落地', async ({
    page,
    request,
  }) => {
    const key = freshKey('preinit');
    // `verifyDelayMs` 让壳的 `handshake/verify` 慢 2.5 s —— 这段时间里子端 SDK 已经
    // 建好、`app.fetch()` 也已经调用，但 `init` 还没到，正是要观察的窗口。
    await boot(page, {
      appOrigin: SDK_APP_ORIGIN,
      api: { verifyDelayMs: 2500 },
      sdk: { preInitPath: `/api/probe?key=${key}` },
    });

    const frame = await sdkFrame(page);
    // 等 SDK 走到 `ready` 相位：attest 已经回来、ready 已经发出，但 init 尚未到达。
    await frame.waitForFunction(
      () => {
        const sdk = (window as unknown as { __kySdk: { state: () => { phase: string } } }).__kySdk;
        return sdk.state().phase === 'ready';
      },
      null,
      { timeout: 20_000 },
    );

    // 关键断言：此刻 `/api/probe` 在后端一条都没有。
    // 注意口径 —— attest（`GET /ky/v1/attest`）是 §5.4 握手第一步，本来就该在 init 前发，
    // 所以这里只数业务 API，不数 attest。桩把两者分在不同路径上正是为了能分开数。
    expect(
      await backendCalls(request, key),
      'init 之前 SDK 就把业务 API 打出去了（§9.3-10 违反）',
    ).toEqual([]);
    const pending = await frame.evaluate(
      () =>
        (window as unknown as { __kySdk: { results: Record<string, unknown> } }).__kySdk.results
          .preInit,
    );
    expect(pending, 'init 前这条 fetch 不该有结局，应当还挂着').toBeUndefined();

    // 放行握手，排队的请求应当自己落地。
    await waitActive(page);
    await frame.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { __kySdk: { results: Record<string, unknown> } }).__kySdk.results
            .preInit,
        ),
      null,
      { timeout: 20_000 },
    );

    const calls = await backendCalls(request, key);
    // 第一次被桩打了 401 → SDK 续期后重放一次 → 共两条，且都带 Bearer。
    expect(calls.length, 'init 之后排队的请求应当真的发出去').toBeGreaterThanOrEqual(1);
    expect(calls[0]?.auth ?? '', '排队放行后的请求必须带上 init 下发的 SAT').toMatch(
      /^Bearer demo\.sat\.token\./u,
    );
  });
});

test.describe('§5.5 / §9.3-10 子端 SDK：401 续期与重放', () => {
  test('安全读 GET 遇 401：续期后只重放一次，且重放用的是新 SAT', async ({ page, request }) => {
    const key = freshKey('get401');
    await boot(page, { appOrigin: SDK_APP_ORIGIN });
    await waitActive(page);
    const frame = await sdkFrame(page);

    const tokenCallsBefore = await apiCallCount(page, '/token');

    const result = (await frame.evaluate(
      ([resultKey, path]) =>
        (
          window as unknown as {
            __kySdk: { get: (k: string, p: string) => Promise<unknown> };
          }
        ).__kySdk.get(resultKey, path),
      ['get401', `/api/probe?key=${key}`],
    )) as SdkFetchResult;

    // 页面拿到的是重放之后的 200 —— 401 对业务代码完全透明。
    expect(result.ok, `GET 401 续期重放后应当成功，实际：${JSON.stringify(result)}`).toBe(true);
    expect(result.status).toBe(200);

    const calls = await backendCalls(request, key);
    expect(
      calls.map((call) => call.method),
      '安全读恰好重放一次：共两条请求',
    ).toEqual(['GET', 'GET']);
    // 重放不是原样重发：必须换成续期拿到的新 SAT，否则又是一个 401。
    expect(calls[0]?.auth, '第一条与重放条的令牌相同 → 说明没真的续期').not.toBe(calls[1]?.auth);
    expect(calls[1]?.auth ?? '').toMatch(/^Bearer demo\.sat\.token\./u);

    // 壳侧：这一轮恰好签发一枚新 SAT。
    expect(
      (await apiCallCount(page, '/token')) - tokenCallsBefore,
      '一次 401 应当只触发一次续期',
    ).toBe(1);

    const counters = (await frame.evaluate(() =>
      (
        window as unknown as { __kySdk: { counters: () => Record<string, number> } }
      ).__kySdk.counters(),
    )) as Record<string, number>;
    expect(counters.authReplays, 'SDK 自己的重放计数应当恰好 1').toBe(1);
  });

  test('写请求 POST 遇 401：续期但绝不自动重放，抛 KyAuthError 交页面用幂等键处理', async ({
    page,
    request,
  }) => {
    const key = freshKey('post401');
    await boot(page, { appOrigin: SDK_APP_ORIGIN });
    await waitActive(page);
    const frame = await sdkFrame(page);

    const result = (await frame.evaluate(
      ([resultKey, path]) =>
        (
          window as unknown as {
            __kySdk: { post: (k: string, p: string) => Promise<unknown> };
          }
        ).__kySdk.post(resultKey, path),
      ['post401', `/api/write?key=${key}`],
    )) as SdkFetchResult;

    expect(result.ok, '写请求 401 不该被吞成成功').toBe(false);
    expect(result.error, '应当抛 KyAuthError').toBe('KyAuthError');

    const calls = await backendCalls(request, key);
    // 只有一条：写请求可能已经落库，重放会造成重复写入，这是 §5.5 明令禁止的。
    expect(
      calls.map((call) => call.method),
      '写请求被自动重放了（§5.5 违反）',
    ).toEqual(['POST']);
  });

  test('三条并发安全读同时撞 401：SDK 单飞续期，壳只签发一枚新 SAT', async ({ page, request }) => {
    const keys = [freshKey('burst-a'), freshKey('burst-b'), freshKey('burst-c')];
    // 让续期端点慢一点，三条 401 才会真的叠在同一个续期窗口里。
    await boot(page, { appOrigin: SDK_APP_ORIGIN, api: { tokenDelayMs: 400 } });
    await waitActive(page);
    const frame = await sdkFrame(page);

    const tokenCallsBefore = await apiCallCount(page, '/token');

    const results = (await frame.evaluate(
      ([resultKeys, paths]) =>
        (
          window as unknown as {
            __kySdk: { burst: (k: string[], p: string[]) => Promise<unknown[]> };
          }
        ).__kySdk.burst(resultKeys, paths),
      [keys, keys.map((key) => `/api/probe?key=${key}`)] as [string[], string[]],
    )) as SdkFetchResult[];

    expect(
      results.every((item) => item.ok),
      '三条并发安全读都应当在重放后成功',
    ).toBe(true);

    expect(
      (await apiCallCount(page, '/token')) - tokenCallsBefore,
      '三条并发 401 只该触发一次续期（单飞）',
    ).toBe(1);

    // 每条各自恰好重放一次，互不牵连。
    for (const key of keys) {
      const calls = await backendCalls(request, key);
      expect(calls.length, `${key} 应当恰好两条（首发 401 + 重放一次）`).toBe(2);
    }

    // 三条重放用的是同一枚新 SAT —— 单飞的可观测证据。
    const replayed = await Promise.all(
      keys.map(async (key) => (await backendCalls(request, key))[1]?.auth ?? ''),
    );
    expect(new Set(replayed).size, '单飞续期后三条应当共用同一枚新 SAT').toBe(1);
  });

  test('SDK 子端与壳的握手本身走通：init 落到真 SDK 上，安装实例一致', async ({ page }) => {
    await boot(page, { appOrigin: SDK_APP_ORIGIN });
    await waitActive(page);
    const frame = await sdkFrame(page);

    const state = (await frame.evaluate(() =>
      (
        window as unknown as {
          __kySdk: { state: () => { phase: string; mode: string; installationId: string | null } };
        }
      ).__kySdk.state(),
    )) as { phase: string; mode: string; installationId: string | null };

    expect(state.mode, '嵌在壳里应当是 embedded').toBe('embedded');
    expect(state.phase, '握手完成后 SDK 相位应当是 active').toBe('active');
    expect(state.installationId).toBe(CRM_IID);
  });
});
