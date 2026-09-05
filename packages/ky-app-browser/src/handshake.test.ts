/** §5.4 握手：attest → ready 重发 → init → init.ack；§9.3-10 的握手相关用例。 */
import { describe, expect, it, vi } from 'vitest';

import { CONTRACT_VERSION, normalizeAppPath } from '@kaiyan/ky-app-contract/browser';

import { createKyApp } from './createKyApp.js';
import {
  APP_ORIGIN,
  SHELL_ORIGIN,
  attestResponse,
  createClock,
  createFetchStub,
  createTestWindow,
  initPayload,
  shellMessage,
} from './__tests__/harness.js';

function setup(options?: { href?: string; nowMs?: number }) {
  const clock = createClock(options?.nowMs);
  const shell = createTestWindow(options?.href === undefined ? undefined : { href: options.href });
  const fetchStub = createFetchStub([attestResponse()]);
  return { clock, shell, fetchStub };
}

describe('握手状态机', () => {
  it('attest → ready → init → init.ack → active', async () => {
    const { clock, shell, fetchStub } = setup();
    const onInit = vi.fn();
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
      onInit,
    });

    await clock.advance(0);
    expect(fetchStub.calls[0]?.url).toBe('/ky/v1/attest?nonce=nonce_demo');

    const ready = shell.lastOfType('ready');
    expect(ready?.payload).toEqual({
      contractVersion: 1,
      path: '/orders',
      installationId: 'iid_demo',
      attestation: 'attest.jwt.value',
    });
    expect(shell.posted[0]?.targetOrigin).toBe(SHELL_ORIGIN);
    expect(app.getState().phase).toBe('ready');

    shell.send(shellMessage('init', initPayload(clock.now()), { id: ready?.id }));
    await clock.advance(0);

    expect(shell.ofType('init.ack')).toHaveLength(1);
    expect(shell.lastOfType('init.ack')?.id).toBe(ready?.id);
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(app.getState().phase).toBe('active');
    expect(app.getState().tokenExp).toBe(initPayload(clock.now()).tokenExp);
    await expect(app.ready()).resolves.toBeUndefined();
    app.destroy();
  });

  it('ready 每 1 s 重发，10 s 未收到 init 则失败', async () => {
    const { clock, shell, fetchStub } = setup();
    const onError = vi.fn();
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
      onError,
    });

    await clock.advance(0);
    expect(shell.ofType('ready')).toHaveLength(1);

    await clock.advance(1000);
    expect(shell.ofType('ready')).toHaveLength(2);
    await clock.advance(3000);
    expect(shell.ofType('ready')).toHaveLength(5);

    await clock.advance(6000);
    expect(shell.ofType('ready')).toHaveLength(10);
    expect(app.getState().counters.readyResends).toBe(9);
    expect(app.getState().phase).toBe('failed');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'handshake_timeout' }));
    await expect(app.ready()).rejects.toThrow();

    // 失败后不再重发。
    await clock.advance(5000);
    expect(shell.ofType('ready')).toHaveLength(10);
    app.destroy();
  });

  it('init.ack 丢失后壳重发 init：再次 init.ack，onInit 只触发一次', async () => {
    const { clock, shell, fetchStub } = setup();
    const onInit = vi.fn();
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
      onInit,
    });
    await clock.advance(0);
    const ready = shell.lastOfType('ready');

    shell.send(shellMessage('init', initPayload(clock.now()), { id: ready?.id }));
    await clock.advance(0);
    // 壳没收到 ack，5 s 后换一个 id 重发 init（§5.4-4 最多 3 次）。
    await clock.advance(5000);
    shell.send(
      shellMessage('init', initPayload(clock.now(), { token: 'sat.token.v2' }), {
        id: 'init-retry-1',
      }),
    );
    await clock.advance(0);

    expect(shell.ofType('init.ack')).toHaveLength(2);
    expect(shell.ofType('init.ack').map((item) => item.id)).toEqual([ready?.id, 'init-retry-1']);
    expect(onInit).toHaveBeenCalledTimes(1);
    // 重发只更新令牌。
    expect(app.getState().tokenExp).toBe(initPayload(clock.now()).tokenExp);
    app.destroy();
  });

  it('重复 (type,id) 重放缓存的同一应答，副作用只执行一次', async () => {
    const { clock, shell, fetchStub } = setup();
    const onInit = vi.fn();
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
      onInit,
    });
    await clock.advance(0);
    const ready = shell.lastOfType('ready');
    const message = shellMessage('init', initPayload(clock.now()), { id: ready?.id });

    shell.send(message);
    shell.send(message);
    shell.send(message);
    await clock.advance(0);

    const acks = shell.ofType('init.ack');
    expect(acks).toHaveLength(3);
    expect(new Set(acks.map((item) => item.id))).toEqual(new Set([ready?.id]));
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(app.getState().counters.replayedReplies).toBe(2);
    app.destroy();
  });

  it('F5 重载：新 nonce 进 attest，ready.path 用 contract 的 normalizeAppPath 规范化', async () => {
    const href = `${APP_ORIGIN}/orders/?ky=1&ky_iid=iid_demo&ky_nonce=nonce_second&status=open&b=2&a=1`;
    const { clock, shell, fetchStub } = setup({ href });
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
    });
    await clock.advance(0);

    expect(fetchStub.calls[0]?.url).toBe('/ky/v1/attest?nonce=nonce_second');
    const path = (shell.lastOfType('ready')?.payload as { path: string }).path;
    // 与 contract 的规范化函数交叉验证：去尾斜杠、剔除保留参数、query 键排序。
    expect(path).toBe(normalizeAppPath('/orders/?ky=1&ky_iid=iid_demo&b=2&a=1&status=open'));
    expect(path).toBe('/orders?a=1&b=2&status=open');
    app.destroy();
  });

  it('attest 失败 → failed，并且一条 ready 都不发', async () => {
    const clock = createClock();
    const shell = createTestWindow();
    const fetchStub = createFetchStub([{ status: 503, body: {} }]);
    const onError = vi.fn();
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
      onError,
    });
    await clock.advance(0);

    expect(shell.ofType('ready')).toHaveLength(0);
    expect(app.getState().phase).toBe('failed');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'attest_failed' }));
    app.destroy();
  });

  it('壳声明 contractVersion=2 时拒绝握手（§9.3-16 的子端一侧）', async () => {
    const { clock, shell, fetchStub } = setup();
    const onError = vi.fn();
    const onInit = vi.fn();
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
      onError,
      onInit,
    });
    await clock.advance(0);
    shell.send(
      shellMessage('init', initPayload(clock.now(), { contractVersion: 2 }), {
        id: shell.lastOfType('ready')?.id,
      }),
    );
    await clock.advance(0);

    expect(shell.ofType('init.ack')).toHaveLength(0);
    expect(onInit).not.toHaveBeenCalled();
    expect(app.getState().phase).toBe('failed');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'contract_version_mismatch' }),
    );
    app.destroy();
  });

  it('contractVersion 常量为 1，且 options 传其他值直接拒绝', () => {
    const { clock, shell, fetchStub } = setup();
    expect(CONTRACT_VERSION).toBe(1);
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
      contractVersion: 1,
    });
    expect(app.contractVersion).toBe(1);
    app.destroy();
    expect(() =>
      createKyApp({
        window: shell.win,
        fetch: fetchStub.impl,
        timers: clock.timers,
        now: clock.now,
        contractVersion: 2 as unknown as 1,
      }),
    ).toThrow(/contractVersion/u);
  });

  it('拿不到壳 origin（无 referrer 且未传 shellOrigin）时一条消息都不发', async () => {
    const clock = createClock();
    const shell = createTestWindow({ referrer: '' });
    const fetchStub = createFetchStub([attestResponse()]);
    const onError = vi.fn();
    const app = createKyApp({
      window: shell.win,
      fetch: fetchStub.impl,
      timers: clock.timers,
      now: clock.now,
      onError,
    });
    await clock.advance(2000);

    expect(shell.posted).toHaveLength(0);
    expect(fetchStub.calls).toHaveLength(0);
    expect(app.getState().phase).toBe('failed');
    expect(app.getState().shellOrigin).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'shell_origin_unknown' }));
    await expect(app.ready()).rejects.toThrow();
    app.destroy();
  });
});
