/** §3.1（`user` 行）+ §5.5 令牌：单飞续期、版本号原子替换、退避与终止性 reason。 */
import { describe, expect, it, vi } from 'vitest';

import { bootstrap, shellMessage } from './__tests__/harness.js';
import { KyAuthError } from './errors.js';

const SECOND = 1000;

describe('令牌与单飞续期', () => {
  it('令牌只在内存：localStorage / sessionStorage 里没有任何痕迹', async () => {
    const { app } = await bootstrap();
    expect(globalThis.localStorage.length).toBe(0);
    expect(globalThis.sessionStorage.length).toBe(0);
    expect(JSON.stringify(app.getState())).not.toContain('sat.token');
    app.destroy();
  });

  it('到期前 60 s 主动续期，并按新 exp 重排下一次', async () => {
    const { app, shell, clock } = await bootstrap();
    const firstExp = app.getState().tokenExp ?? 0;

    await clock.advance(239 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(0);

    await clock.advance(1 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(1);

    shell.send(
      shellMessage(
        'token.refresh',
        { token: 'sat.token.v2', tokenExp: firstExp + 300 },
        { id: shell.lastOfType('token.request')?.id },
      ),
    );
    await clock.advance(0);
    expect(app.getState().tokenExp).toBe(firstExp + 300);
    expect(app.getState().counters.refreshes).toBe(1);

    // 下一次仍然是新 exp 前 60 s（新令牌剩余 360 s → 再过 300 s）。
    await clock.advance(299 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(1);
    await clock.advance(1 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(2);
    app.destroy();
  });

  it('单飞：多个触发点并发只发一条 token.request', async () => {
    const { app, shell, clock } = await bootstrap();

    await clock.advance(240 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(1);
    // 换成一枚只剩 25 s 的令牌，让「回前台」与「请求前按需续期」都会想续期。
    shell.send(
      shellMessage(
        'token.refresh',
        { token: 'sat.token.short', tokenExp: Math.floor(clock.now() / 1000) + 25 },
        { id: shell.lastOfType('token.request')?.id },
      ),
    );
    await clock.advance(0);
    expect(shell.ofType('token.request')).toHaveLength(1);

    shell.send(shellMessage('visibility', { visible: true }));
    // 这两个请求会一直等续期结果；测试只关心发出的 token.request 条数。
    void app.fetch('/api/app/orders').catch(() => undefined);
    void app.fetch('/api/app/items').catch(() => undefined);
    await clock.advance(0);
    expect(shell.ofType('token.request')).toHaveLength(2);

    // 主动续期定时器到点时同样并入在途的那一条。
    await clock.advance(1 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(2);
    app.destroy();
  });

  it('版本号原子替换：旧续期结果不覆盖期间落地的新令牌', async () => {
    const { app, shell, clock } = await bootstrap();
    const baseExp = app.getState().tokenExp ?? 0;

    await clock.advance(240 * SECOND);
    const request = shell.lastOfType('token.request');
    expect(request).toBeDefined();

    // 续期在途时壳主动推送了更新的令牌（无 id）。
    shell.send(
      shellMessage('token.refresh', { token: 'sat.token.newer', tokenExp: baseExp + 900 }),
    );
    await clock.advance(0);
    expect(app.getState().tokenExp).toBe(baseExp + 900);

    // 迟到的旧应答不得回退令牌。
    shell.send(
      shellMessage(
        'token.refresh',
        { token: 'sat.token.stale', tokenExp: baseExp + 300 },
        { id: request?.id },
      ),
    );
    await clock.advance(0);
    expect(app.getState().tokenExp).toBe(baseExp + 900);
    app.destroy();
  });

  it('temporary 指数退避：1 s → 2 s → 4 s，上限 30 s', async () => {
    const { app, shell, clock } = await bootstrap();

    await clock.advance(240 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(1);

    const failOnce = async (delayMs: number, expected: number): Promise<void> => {
      shell.send(
        shellMessage(
          'token.refresh.error',
          { reason: 'temporary' },
          { id: shell.lastOfType('token.request')?.id },
        ),
      );
      await clock.advance(delayMs - 1);
      expect(shell.ofType('token.request')).toHaveLength(expected - 1);
      await clock.advance(1);
      expect(shell.ofType('token.request')).toHaveLength(expected);
    };

    await failOnce(1 * SECOND, 2);
    await failOnce(2 * SECOND, 3);
    await failOnce(4 * SECOND, 4);
    expect(app.getState().counters.refreshFailures).toBe(3);
    app.destroy();
  });

  it('终止性 reason：停止请求、清空令牌并回调 onTokenError', async () => {
    const onTokenError = vi.fn();
    const { app, shell, clock } = await bootstrap({ onTokenError });

    await clock.advance(240 * SECOND);
    shell.send(
      shellMessage(
        'token.refresh.error',
        { reason: 'session_expired' },
        { id: shell.lastOfType('token.request')?.id },
      ),
    );
    await clock.advance(0);

    expect(onTokenError).toHaveBeenCalledExactlyOnceWith('session_expired');
    expect(app.getState().tokenExp).toBeNull();

    // 之后不再发任何续期请求。
    await clock.advance(120 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(1);
    await expect(app.fetch('/api/app/orders')).rejects.toBeInstanceOf(KyAuthError);
    app.destroy();
  });

  it('壳主动推送 token.refresh.error(installation_disabled) 同样终止', async () => {
    const onTokenError = vi.fn();
    const { app, shell, clock } = await bootstrap({ onTokenError });
    shell.send(shellMessage('token.refresh.error', { reason: 'installation_disabled' }));
    await clock.advance(0);
    expect(onTokenError).toHaveBeenCalledExactlyOnceWith('installation_disabled');
    expect(app.getState().tokenExp).toBeNull();
    app.destroy();
  });

  it('回前台：剩余充足不续期，剩余 < 30 s 才续期', async () => {
    const onVisibility = vi.fn();
    const { app, shell, clock } = await bootstrap({ onVisibility });

    shell.send(shellMessage('visibility', { visible: false }));
    shell.send(shellMessage('visibility', { visible: true }));
    await clock.advance(0);
    expect(onVisibility).toHaveBeenCalledTimes(2);
    expect(shell.ofType('token.request')).toHaveLength(0);

    await clock.advance(240 * SECOND);
    // 主动续期发了一条；用一枚只剩 25 s 的令牌应答它。
    expect(shell.ofType('token.request')).toHaveLength(1);
    shell.send(
      shellMessage(
        'token.refresh',
        { token: 'sat.token.short', tokenExp: Math.floor(clock.now() / 1000) + 25 },
        { id: shell.lastOfType('token.request')?.id },
      ),
    );
    await clock.advance(0);
    expect(shell.ofType('token.request')).toHaveLength(1);

    // 这次回前台时剩余 < 30 s，必须续期。
    shell.send(shellMessage('visibility', { visible: true }));
    await clock.advance(0);
    expect(shell.ofType('token.request')).toHaveLength(2);
    app.destroy();
  });

  it('token.request 5 s 无应答：计一次超时并进入退避重试', async () => {
    const { app, shell, clock } = await bootstrap();
    await clock.advance(240 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(1);

    await clock.advance(5 * SECOND);
    expect(app.getState().counters.requestTimeouts).toBe(1);
    expect(app.getState().counters.refreshFailures).toBe(1);

    await clock.advance(1 * SECOND);
    expect(shell.ofType('token.request')).toHaveLength(2);
    app.destroy();
  });
});
