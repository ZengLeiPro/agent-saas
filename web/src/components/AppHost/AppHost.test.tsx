/**
 * AppHost 的 React 层：§5.1 iframe 属性、§5.5「隐藏不卸载」、§6.6 失败态与重试、
 * 壳内条幅。握手状态机与消息路由的行为在 `controller.test.ts`。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const logout = vi.fn(async () => {});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ logout }) }));

const authFetch = vi.fn(async () => new Response('{}', { status: 200 }));
vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetch(...(args as [])),
}));

const { cn } = await import('@/lib/utils');
const { parseAppsPath } = await import('@/lib/urlSync');
const { __setMySystemsLoaderForTests } = await import('@/lib/mySystemsSource');
const { AppHost } = await import('./index');
const { installationFixture } = await import('./testFixtures');

function useInstallations(installations = [installationFixture()]): void {
  __setMySystemsLoaderForTests(async () => ({ installations }));
}

function Region({ hidden, path }: { hidden: boolean; path: string | null }) {
  return (
    <div
      className={cn('min-h-0 flex-1 overflow-hidden', hidden && 'hidden')}
      data-testid="apps-region"
    >
      <AppHost appsRoute={path === null ? null : parseAppsPath(path)} />
    </div>
  );
}

afterEach(() => {
  __setMySystemsLoaderForTests(null);
  authFetch.mockClear();
  authFetch.mockImplementation(
    async () => new Response(JSON.stringify({ nonce: 'n'.repeat(32), expiresAt: '' }), { status: 200 }),
  );
});

describe('壳路由与占位', () => {
  it('带壳路由时把安装实例与应用内路径挂到 DOM 上', async () => {
    useInstallations();
    render(<Region hidden={false} path="/apps/inst-1/orders?a=1" />);
    await screen.findByTestId('app-host-frame');
    const host = screen.getByTestId('app-host');
    expect(host.getAttribute('data-installation-id')).toBe('inst-1');
    expect(host.getAttribute('data-app-path')).toBe('/orders?a=1');
  });

  it('没有壳路由时给出选择提示，不报错', async () => {
    useInstallations();
    render(<Region hidden={false} path={null} />);
    await waitFor(() =>
      expect(screen.getByTestId('app-host').textContent).toContain('请选择一个定制软件'),
    );
  });
});

describe('§5.1 iframe 属性一字不差', () => {
  it('sandbox / allow / referrerpolicy 与规范完全一致，且无 allow-popups、allow-top-navigation', async () => {
    useInstallations();
    authFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ nonce: 'n'.repeat(32), expiresAt: '' }), { status: 200 }),
    );
    render(<Region hidden={false} path="/apps/inst-1/orders" />);
    const frame = await screen.findByTestId('app-host-frame');
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals',
    );
    expect(frame.getAttribute('allow')).toBe('clipboard-write');
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-popups');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
  });

  it('src 注入 ky / ky_iid / ky_nonce 且保留 baseUrl 原有 query（§5.2）', async () => {
    useInstallations([installationFixture({ origin: 'https://crm.example.com/base?tenant=t1' })]);
    render(<Region hidden={false} path="/apps/inst-1/orders?a=1" />);
    const frame = await screen.findByTestId('app-host-frame');
    const src = new URL(frame.getAttribute('src') ?? '');
    expect(src.origin).toBe('https://crm.example.com');
    expect(src.pathname).toBe('/orders');
    expect(src.searchParams.get('a')).toBe('1');
    expect(src.searchParams.get('ky')).toBe('1');
    expect(src.searchParams.get('ky_iid')).toBe('inst-1');
    expect(src.searchParams.get('ky_nonce')).toBe('n'.repeat(32));
  });
});

describe('§6.6 失败态', () => {
  it('系统停用 / 不再可见 → 「暂不可用」，不给重试按钮', async () => {
    useInstallations([]);
    render(<Region hidden={false} path="/apps/inst-404/orders" />);
    const failure = await screen.findByTestId('app-host-failure');
    expect(failure.textContent).toContain('暂不可用');
    expect(screen.queryByTestId('app-host-retry')).toBeNull();
    expect(screen.queryByTestId('app-host-frame')).toBeNull();
  });

  it('握手失败 → 系统名 + 已通知技术支持 + 重试按钮，且不写技术归因', async () => {
    useInstallations();
    authFetch.mockImplementation(async () => new Response('{}', { status: 503 }));
    render(<Region hidden={false} path="/apps/inst-1/orders" />);
    const failure = await screen.findByTestId('app-host-failure');
    expect(failure.textContent).toContain('《客户管理》暂时无法加载，已通知技术支持');
    expect(failure.textContent).not.toMatch(/503|HTTP|nonce/i);
    expect(screen.getByTestId('app-host-retry')).not.toBeNull();
  });

  it('重试重新走握手', async () => {
    useInstallations();
    authFetch.mockImplementation(async () => new Response('{}', { status: 503 }));
    render(<Region hidden={false} path="/apps/inst-1/orders" />);
    await screen.findByTestId('app-host-retry');
    const before = authFetch.mock.calls.length;
    authFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ nonce: 'n'.repeat(32), expiresAt: '' }), { status: 200 }),
    );
    await userEvent.click(screen.getByTestId('app-host-retry'));
    await waitFor(() => expect(authFetch.mock.calls.length).toBeGreaterThan(before));
    await screen.findByTestId('app-host-frame');
  });
});

describe('§5.5 切走再切回保持挂载', () => {
  it('切走只加 hidden class，DOM 节点与组件实例都不重建', async () => {
    useInstallations();
    const { rerender } = render(<Region hidden={false} path="/apps/inst-1/orders" />);
    await screen.findByTestId('app-host-frame');
    const first = screen.getByTestId('app-host');
    const mountId = first.getAttribute('data-app-host-mount');
    expect(mountId).not.toBeNull();
    expect(screen.getByTestId('apps-region').classList.contains('hidden')).toBe(false);

    rerender(<Region hidden path="/apps/inst-1/orders" />);
    const whileHidden = screen.getByTestId('app-host');
    expect(screen.getByTestId('apps-region').classList.contains('hidden')).toBe(true);
    expect(whileHidden).toBe(first);
    expect(whileHidden.getAttribute('data-app-host-mount')).toBe(mountId);

    rerender(<Region hidden={false} path="/apps/inst-1/orders" />);
    const back = screen.getByTestId('app-host');
    expect(back).toBe(first);
    expect(back.getAttribute('data-app-host-mount')).toBe(mountId);
    expect(screen.getByTestId('apps-region').classList.contains('hidden')).toBe(false);
  });

  it('条件卸载会换来新的挂载序号（反证上一条不是恒真断言）', async () => {
    useInstallations();
    const { unmount } = render(<Region hidden={false} path="/apps/inst-1/orders" />);
    await screen.findByTestId('app-host-frame');
    const before = screen.getByTestId('app-host').getAttribute('data-app-host-mount');
    unmount();
    render(<Region hidden={false} path="/apps/inst-1/orders" />);
    await screen.findByTestId('app-host-frame');
    expect(screen.getByTestId('app-host').getAttribute('data-app-host-mount')).not.toBe(before);
  });
});
