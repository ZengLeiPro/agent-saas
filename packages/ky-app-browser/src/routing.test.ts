/** §5.2 / §5.4 路由同步：route.navigate → route.result、navId 回声抑制、syncHistory。 */
import { describe, expect, it, vi } from 'vitest';

import { bootstrap, shellMessage } from './__tests__/harness.js';
import type { KyRouteOutcome } from './types.js';

describe('路由同步', () => {
  it('route.navigate → onRoute → route.result（回带 id 与 navId）', async () => {
    const onRoute = vi.fn(() => ({ ok: true }) as KyRouteOutcome);
    const { app, shell, clock } = await bootstrap({ onRoute });

    shell.send(
      shellMessage('route.navigate', { path: '/orders/123' }, { id: 'nav-1', navId: 'n1' }),
    );
    await clock.advance(0);

    expect(onRoute).toHaveBeenCalledExactlyOnceWith('/orders/123', { navId: 'n1' });
    const result = shell.lastOfType('route.result');
    expect(result?.id).toBe('nav-1');
    expect(result?.navId).toBe('n1');
    expect(result?.payload).toEqual({ ok: true, path: '/orders/123' });
    app.destroy();
  });

  it('应用层拒绝时回 reason，且不建立回声', async () => {
    const onRoute = vi.fn(() => ({ ok: false, reason: 'forbidden' }) as KyRouteOutcome);
    const { app, shell, clock } = await bootstrap({ onRoute });

    shell.send(
      shellMessage('route.navigate', { path: '/admin/roles' }, { id: 'nav-2', navId: 'n2' }),
    );
    await clock.advance(0);
    expect(shell.lastOfType('route.result')?.payload).toEqual({ ok: false, reason: 'forbidden' });

    app.routeChanged('/admin/roles');
    expect(shell.lastOfType('route.changed')?.navId).toBeUndefined();
    app.destroy();
  });

  it('navId 回声抑制：同一路径的第一次上报携带 navId，之后不再携带', async () => {
    const onRoute = vi.fn(() => ({ ok: true }) as KyRouteOutcome);
    const { app, shell, clock } = await bootstrap({ onRoute });

    shell.send(shellMessage('route.navigate', { path: '/orders' }, { id: 'nav-3', navId: 'n3' }));
    await clock.advance(0);

    app.routeChanged('/orders', '订单');
    const echo = shell.lastOfType('route.changed');
    expect(echo?.navId).toBe('n3');
    expect(echo?.payload).toEqual({ path: '/orders', title: '订单' });

    // 用户自己点出去的导航不是回声，不带 navId。
    app.routeChanged('/orders/9');
    expect(shell.lastOfType('route.changed')?.navId).toBeUndefined();
    app.destroy();
  });

  it('应用层重定向到别的路径时，回声跟着重定向后的路径走', async () => {
    const onRoute = vi.fn(() => ({ ok: true, path: '/orders/list' }) as KyRouteOutcome);
    const { app, shell, clock } = await bootstrap({ onRoute });

    shell.send(shellMessage('route.navigate', { path: '/orders' }, { id: 'nav-4', navId: 'n4' }));
    await clock.advance(0);
    expect(shell.lastOfType('route.result')?.payload).toEqual({
      ok: true,
      path: '/orders/list',
    });

    app.routeChanged('/orders/list');
    expect(shell.lastOfType('route.changed')?.navId).toBe('n4');
    app.destroy();
  });

  it('重复 (route.navigate,id) 重放同一 route.result，onRoute 只跑一次', async () => {
    const onRoute = vi.fn(() => ({ ok: true }) as KyRouteOutcome);
    const { app, shell, clock } = await bootstrap({ onRoute });
    const message = shellMessage(
      'route.navigate',
      { path: '/orders' },
      { id: 'nav-5', navId: 'n5' },
    );

    shell.send(message);
    shell.send(message);
    await clock.advance(0);

    expect(onRoute).toHaveBeenCalledTimes(1);
    expect(shell.ofType('route.result')).toHaveLength(2);
    expect(app.getState().counters.replayedReplies).toBe(1);
    app.destroy();
  });

  it('route.navigate 的 path 走 contract 规范化（剔除保留参数、去尾斜杠、query 排序）', async () => {
    const onRoute = vi.fn(() => ({ ok: true }) as KyRouteOutcome);
    const { app, shell, clock } = await bootstrap({ onRoute });

    shell.send(
      shellMessage(
        'route.navigate',
        { path: '/orders/?ky=1&ky_iid=iid_demo&z=1&a=2' },
        { id: 'nav-6', navId: 'n6' },
      ),
    );
    await clock.advance(0);
    expect(onRoute).toHaveBeenCalledExactlyOnceWith('/orders?a=2&z=1', { navId: 'n6' });
    app.destroy();
  });

  it('没有注册 onRoute 时回 not_found', async () => {
    const { app, shell, clock } = await bootstrap();
    shell.send(shellMessage('route.navigate', { path: '/orders' }, { id: 'nav-7' }));
    await clock.advance(0);
    expect(shell.lastOfType('route.result')?.payload).toEqual({ ok: false, reason: 'not_found' });
    app.destroy();
  });

  it('syncHistory：用户导航 pushState、重定向 replaceState，并上报 route.changed', async () => {
    const { app, shell } = await bootstrap();

    app.syncHistory('/orders/1');
    app.syncHistory('/orders/list', { mode: 'replace', title: '订单列表' });

    expect(shell.history).toEqual([
      { mode: 'push', url: '/orders/1' },
      { mode: 'replace', url: '/orders/list' },
    ]);
    expect(shell.ofType('route.changed').map((item) => item.payload)).toEqual([
      { path: '/orders/1' },
      { path: '/orders/list', title: '订单列表' },
    ]);
    app.destroy();
  });

  it('theme.changed 透传给 onTheme', async () => {
    const onTheme = vi.fn();
    const { app, shell, clock } = await bootstrap({ onTheme });
    shell.send(shellMessage('theme.changed', { theme: 'dark' }));
    await clock.advance(0);
    expect(onTheme).toHaveBeenCalledExactlyOnceWith('dark');
    app.destroy();
  });
});
