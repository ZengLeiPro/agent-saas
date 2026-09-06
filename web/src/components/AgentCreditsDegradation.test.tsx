/**
 * §6.4 积分耗尽的壳层降级：**Agent 入口置灰 + 文案，定制软件照常可用**。
 *
 * 「定制软件不受影响」这半条比置灰那半条更重要 —— 客户刚上线的业务系统不该被
 * Agent 的额度问题连坐。这里把两块放在同一棵树里渲染，一次断死两边。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BillingAllowance } from '@agent/shared';

const allowance: { current: BillingAllowance | null } = { current: null };
vi.mock('@/hooks/useTenantBillingVisibility', () => ({
  useTenantBillingAllowance: () => ({ summary: null, allowance: allowance.current }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { tenantId: 't1' } }),
}));

const { SidebarNav } = await import('./DesktopSessionSidebarControls');
const { AppsSidebarPanel } = await import('./AppsSidebarPanel');
const { __setMySystemsLoaderForTests } = await import('@/lib/mySystemsSource');
const { installationFixture } = await import('./AppHost/testFixtures');

function Sidebar({ onNew }: { onNew: () => void }) {
  return (
    <div>
      <SidebarNav
        navItems={[{ tab: 'capabilities', label: '能力中心' }]}
        activeTab="chat"
        isNewSessionActive={false}
        isLoading={false}
        onNew={onNew}
        onTabChange={() => {}}
      />
      <AppsSidebarPanel />
    </div>
  );
}

afterEach(() => {
  allowance.current = null;
  __setMySystemsLoaderForTests(null);
});

describe('积分耗尽（§6.4）', () => {
  it('额度用完：新建会话置灰 + 文案，定制软件入口照常可点', async () => {
    allowance.current = { credits: 0, source: 'tenant' };
    __setMySystemsLoaderForTests(async () => ({ installations: [installationFixture()] }));
    const onNew = vi.fn();
    render(<Sidebar onNew={onNew} />);

    const newSession = screen.getByRole('button', { name: /新建会话/ });
    expect((newSession as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('agent-credits-exhausted').textContent).toBe(
      '本组织的 AI 额度已用完，已通知管理员',
    );

    // 定制软件不受影响：条目在、可点、点了真的跳
    const appEntry = await screen.findByTestId('apps-nav-inst-1');
    expect((appEntry as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(appEntry);
    expect(window.location.pathname).toBe('/apps/inst-1');
  });

  it('还有额度：既不置灰也不出文案', async () => {
    allowance.current = { credits: 100, source: 'tenant' };
    __setMySystemsLoaderForTests(async () => ({ installations: [installationFixture()] }));
    render(<Sidebar onNew={vi.fn()} />);
    expect((screen.getByRole('button', { name: /新建会话/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByTestId('agent-credits-exhausted')).toBeNull();
  });

  it('计费未开启 / 还没加载完（allowance 为 null）不降级', async () => {
    allowance.current = null;
    __setMySystemsLoaderForTests(async () => ({ installations: [] }));
    render(<Sidebar onNew={vi.fn()} />);
    expect((screen.getByRole('button', { name: /新建会话/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByTestId('agent-credits-exhausted')).toBeNull();
  });
});
