/**
 * WP4 Phase A：AppHost 占位与 §5.5「隐藏不卸载」。
 *
 * 这条是 §11.1 的验收项之一（切走再切回保留页面与滚动位置、Agent 草稿不丢）。
 * 实现手段是 `cn(..., activeTab !== "apps" && "hidden")` —— 只加 class，不条件卸载。
 * 这里用挂载序号钉死「切走再切回没有重挂载」；DesktopLayout 是否真的用了这个模式，
 * 由 `layouts/DesktopLayout.appsWiring.test.ts` 的源码断言把守。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { cn } from '@/lib/utils';
import { parseAppsPath } from '@/lib/urlSync';
import { AppHost } from './index';

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

describe('AppHost 占位', () => {
  it('带壳路由时渲染安装实例与应用内路径', () => {
    render(<Region hidden={false} path="/apps/inst-1/orders?a=1" />);
    const host = screen.getByTestId('app-host');
    expect(host.getAttribute('data-installation-id')).toBe('inst-1');
    expect(host.getAttribute('data-app-path')).toBe('/orders?a=1');
  });

  it('没有壳路由时给出选择提示，不报错', () => {
    render(<Region hidden={false} path={null} />);
    expect(screen.getByTestId('app-host').textContent).toContain('请选择一个定制软件');
  });
});

describe('§5.5 切走再切回保持挂载', () => {
  it('切走只加 hidden class，DOM 节点与组件实例都不重建', () => {
    const { rerender } = render(<Region hidden={false} path="/apps/inst-1/orders" />);
    const first = screen.getByTestId('app-host');
    const mountId = first.getAttribute('data-app-host-mount');
    expect(mountId).not.toBeNull();
    expect(screen.getByTestId('apps-region').classList.contains('hidden')).toBe(false);

    // 切到别的标签
    rerender(<Region hidden path="/apps/inst-1/orders" />);
    const whileHidden = screen.getByTestId('app-host');
    expect(screen.getByTestId('apps-region').classList.contains('hidden')).toBe(true);
    expect(whileHidden).toBe(first);
    expect(whileHidden.getAttribute('data-app-host-mount')).toBe(mountId);

    // 再切回来
    rerender(<Region hidden={false} path="/apps/inst-1/orders" />);
    const back = screen.getByTestId('app-host');
    expect(back).toBe(first);
    expect(back.getAttribute('data-app-host-mount')).toBe(mountId);
    expect(screen.getByTestId('apps-region').classList.contains('hidden')).toBe(false);
  });

  it('条件卸载会换来新的挂载序号（反证上一条不是恒真断言）', () => {
    const { unmount } = render(<Region hidden={false} path="/apps/inst-1/orders" />);
    const before = screen.getByTestId('app-host').getAttribute('data-app-host-mount');
    unmount();
    render(<Region hidden={false} path="/apps/inst-1/orders" />);
    expect(screen.getByTestId('app-host').getAttribute('data-app-host-mount')).not.toBe(before);
  });
});
