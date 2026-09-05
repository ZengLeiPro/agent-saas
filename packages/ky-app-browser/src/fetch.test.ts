/** §5.5 `fetch` 包装：令牌附带范围、init 前排队、401 重放策略、`X-KY-Perm-Version`。 */
import { describe, expect, it, vi } from 'vitest';

import {
  APP_ORIGIN,
  attestResponse,
  bootstrap,
  createClock,
  createFetchStub,
  createTestWindow,
  initPayload,
  shellMessage,
} from './__tests__/harness.js';
import { createKyApp } from './createKyApp.js';
import { KyAuthError } from './errors.js';

function authOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers;
  if (!Array.isArray(headers)) return undefined;
  return headers.find(([name]) => name === 'Authorization')?.[1];
}

/** 业务请求（跳过 attest 那一条）。 */
function businessCalls(calls: { url: string; init?: RequestInit }[]) {
  return calls.filter((call) => !call.url.includes('/ky/v1/attest'));
}

describe('fetch 包装', () => {
  it('同源相对路径带 Bearer；跨源不带', async () => {
    const { app, fetchStub } = await bootstrap();

    await app.fetch('/api/app/orders');
    await app.fetch(`${APP_ORIGIN}/api/app/items`);
    await app.fetch('https://third-party.example.com/api/x');

    const calls = businessCalls(fetchStub.calls);
    expect(authOf(calls[0]?.init)).toBe('Bearer sat.token.v1');
    expect(authOf(calls[1]?.init)).toBe('Bearer sat.token.v1');
    expect(authOf(calls[2]?.init)).toBeUndefined();
    app.destroy();
  });

  it('KY_ORIGIN 同源也带令牌', async () => {
    const other = 'https://api.demo.apps.kaiyancn.com';
    const { app, fetchStub } = await bootstrap({ appOrigin: other });
    await app.fetch(`${other}/api/app/orders`);
    expect(authOf(businessCalls(fetchStub.calls)[0]?.init)).toBe('Bearer sat.token.v1');
    app.destroy();
  });

  it('init 之前不发请求：排队到 active 才发出', async () => {
    const clock = createClock();
    const shell = createTestWindow();
    const fetchStub = createFetchStub([attestResponse()]);
    fetchStub.routes.set('/ky/v1/attest', [attestResponse()]);
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
    });

    const pending = app.fetch('/api/app/orders');
    await clock.advance(0);
    expect(businessCalls(fetchStub.calls)).toHaveLength(0);

    shell.send(
      shellMessage('init', initPayload(clock.now()), { id: shell.lastOfType('ready')?.id }),
    );
    await clock.advance(0);
    await pending;
    expect(businessCalls(fetchStub.calls)).toHaveLength(1);
    app.destroy();
  });

  it('握手失败时排队的请求以 KyAuthError 结束，且从未发出', async () => {
    const clock = createClock();
    const shell = createTestWindow();
    const fetchStub = createFetchStub([attestResponse()]);
    fetchStub.routes.set('/ky/v1/attest', [attestResponse()]);
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
    });
    const pending = app.fetch('/api/app/orders');
    await clock.advance(11_000);

    await expect(pending).rejects.toBeInstanceOf(KyAuthError);
    expect(businessCalls(fetchStub.calls)).toHaveLength(0);
    app.destroy();
  });

  it('401 → 单飞续期 → GET 只自动重放一次', async () => {
    const { app, shell, clock, fetchStub } = await bootstrap();
    fetchStub.routes.set('/api/app/orders', [{ status: 401 }, { status: 200, body: { ok: true } }]);

    const pending = app.fetch('/api/app/orders');
    await clock.advance(0);

    // 续期请求已发出，壳给一枚新令牌。
    expect(shell.ofType('token.request')).toHaveLength(1);
    shell.send(
      shellMessage(
        'token.refresh',
        { token: 'sat.token.v2', tokenExp: Math.floor(clock.now() / 1000) + 300 },
        { id: shell.lastOfType('token.request')?.id },
      ),
    );
    await clock.advance(0);
    const response = await pending;

    expect(response.status).toBe(200);
    const calls = businessCalls(fetchStub.calls);
    expect(calls).toHaveLength(2);
    expect(authOf(calls[0]?.init)).toBe('Bearer sat.token.v1');
    expect(authOf(calls[1]?.init)).toBe('Bearer sat.token.v2');
    expect(app.getState().counters.authReplays).toBe(1);
    app.destroy();
  });

  it('401 的写请求不重放，抛 KyAuthError 交页面用幂等键处理', async () => {
    const { app, shell, clock, fetchStub } = await bootstrap();
    fetchStub.routes.set('/api/app/orders', [{ status: 401 }, { status: 200 }]);

    const pending = app.fetch('/api/app/orders', {
      method: 'POST',
      headers: { 'X-KY-Idempotency-Key': 'lcid_1' },
    });
    await clock.advance(0);
    shell.send(
      shellMessage(
        'token.refresh',
        { token: 'sat.token.v2', tokenExp: Math.floor(clock.now() / 1000) + 300 },
        { id: shell.lastOfType('token.request')?.id },
      ),
    );
    await clock.advance(0);

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(KyAuthError);
    expect((error as KyAuthError).reason).toBe('unauthorized');
    expect((error as KyAuthError).response?.status).toBe(401);
    expect(businessCalls(fetchStub.calls)).toHaveLength(1);
    expect(app.getState().counters.authReplays).toBe(0);
    app.destroy();
  });

  it('X-KY-Perm-Version 变化触发 perm.changed 与 onPermChanged', async () => {
    const onPermChanged = vi.fn();
    const { app, shell, fetchStub } = await bootstrap({ onPermChanged });
    fetchStub.routes.set('/api/app/orders', [
      { status: 200, headers: { 'X-KY-Perm-Version': 'v7' } },
      { status: 200, headers: { 'X-KY-Perm-Version': 'v7' } },
      { status: 200, headers: { 'X-KY-Perm-Version': 'v8' } },
    ]);

    await app.fetch('/api/app/orders');
    await app.fetch('/api/app/orders');
    await app.fetch('/api/app/orders');

    expect(shell.ofType('perm.changed').map((item) => item.payload)).toEqual([
      { permVersion: 'v7' },
      { permVersion: 'v8' },
    ]);
    expect(onPermChanged.mock.calls).toEqual([['v7'], ['v8']]);
    expect(app.getState().counters.permChanges).toBe(2);
    app.destroy();
  });

  it('调用方自带的 Authorization 头会被 SAT 覆盖', async () => {
    const { app, fetchStub } = await bootstrap();
    await app.fetch('/api/app/orders', { headers: { authorization: 'Bearer 伪造的' } });
    const headers = businessCalls(fetchStub.calls)[0]?.init?.headers;
    expect(headers).toEqual([['Authorization', 'Bearer sat.token.v1']]);
    app.destroy();
  });
});

describe('standalone 模式', () => {
  it('没有 ky=1：不握手、不发任何消息、fetch 不带令牌', async () => {
    const clock = createClock();
    const shell = createTestWindow({ href: `${APP_ORIGIN}/ky-local/login` });
    const fetchStub = createFetchStub([{ status: 200, body: { ok: true } }]);
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
    });

    await clock.advance(15_000);
    const response = await app.fetch('/ky-local/enable', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(shell.posted).toHaveLength(0);
    expect(shell.listeners.size).toBe(0);
    expect(fetchStub.calls.every((call) => !call.url.includes('/ky/v1/attest'))).toBe(true);
    expect(authOf(fetchStub.calls[0]?.init)).toBeUndefined();
    expect(app.getState().phase).toBe('standalone');
    expect(app.getState().mode).toBe('standalone');
    await expect(app.ready()).resolves.toBeUndefined();

    // 子→壳 API 在 standalone 下全部是空操作。
    app.toast({ level: 'info', message: '本地模式' });
    app.openAgent({ prompt: '你好' });
    app.requestLogout();
    app.routeChanged('/orders');
    expect(shell.posted).toHaveLength(0);
    app.destroy();
  });
});
