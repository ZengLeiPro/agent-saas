/**
 * WP4 Phase A：左栏「定制软件」入口（规范 §5.2、§10、§6.6）。
 *
 * 钉死三条：
 * 1. `apps` **不进** `baseNavItems`——进了移动端就会跟着长出入口，`mobile-contract` 会红；
 * 2. 每个安装实例一项、图标取 `MySystemInstallation.icon`；
 * 3. 点击走土制路由 `navigateApps`，选中态以 URL 为准（同一标签下多实例）。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { baseNavItems, getSidebarNavItems } from '@/types/sidebar';
import type { MySystemInstallation } from '@/lib/systemsApi';
import { AppsSidebarPanel, buildAppsNavItems, isRenderableIconGlyph } from './AppsSidebarPanel';

function installation(overrides: Partial<MySystemInstallation> = {}): MySystemInstallation {
  return {
    installationId: 'inst-1',
    systemId: 'crm',
    name: '客户管理',
    icon: '📦',
    origin: 'https://t1-crm.apps.example.com',
    state: 'enabled',
    ...overrides,
  };
}

describe('apps 标签不进共用导航', () => {
  it('baseNavItems 不含 apps', () => {
    expect(baseNavItems.some((item) => item.tab === 'apps')).toBe(false);
  });

  it('getSidebarNavItems 的任何组合都不产出 apps', () => {
    for (const isAdmin of [true, false]) {
      for (const personalAgentEnabled of [true, false]) {
        const items = getSidebarNavItems({ isAdmin, personalAgentEnabled });
        expect(items.some((item) => item.tab === 'apps')).toBe(false);
      }
    }
  });
});

describe('buildAppsNavItems', () => {
  it('每个安装实例一项，图标取 installation.icon', () => {
    const items = buildAppsNavItems([
      installation(),
      installation({ installationId: 'inst-2', systemId: 'wms', name: '仓库', icon: null }),
    ]);
    expect(items).toEqual([
      { tab: 'apps', installationId: 'inst-1', label: '客户管理', icon: '📦' },
      { tab: 'apps', installationId: 'inst-2', label: '仓库', icon: null },
    ]);
  });

  it('名称为空时回落 systemId', () => {
    expect(buildAppsNavItems([installation({ name: '' })])[0].label).toBe('crm');
  });

  it('空列表产出空数组', () => {
    expect(buildAppsNavItems([])).toEqual([]);
  });
});

describe('icon 渲染判定', () => {
  it.each(['📦', '仓', 'CRM'])('短字形 %s 直接渲染', (icon) => {
    expect(isRenderableIconGlyph(icon)).toBe(true);
  });

  it.each([null, '', '   ', 'https://x/y.png', '/icons/a.svg', 'data:image/png;base64,AAA'])(
    '非字形 %j 回落默认图标',
    (icon) => {
      expect(isRenderableIconGlyph(icon)).toBe(false);
    },
  );
});

describe('AppsSidebarPanel 渲染与导航', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('渲染每个安装实例一项', async () => {
    render(
      <AppsSidebarPanel
        loadInstallations={async () => ({
          installations: [
            installation(),
            installation({ installationId: 'inst-2', systemId: 'wms', name: '仓库' }),
          ],
        })}
      />,
    );
    expect((await screen.findByTestId('apps-nav-inst-1')).textContent).toContain('客户管理');
    expect(screen.getByTestId('apps-nav-inst-2').textContent).toContain('仓库');
  });

  it('没有可见系统时整块不渲染（含 /api/systems/mine 404 → 空列表）', async () => {
    const { container } = render(
      <AppsSidebarPanel loadInstallations={async () => ({ installations: [] })} />,
    );
    await waitFor(() => expect(container.querySelector('nav')).toBeNull());
  });

  it('拉取失败只给客户面文案与重试，不写技术归因', async () => {
    let attempts = 0;
    render(
      <AppsSidebarPanel
        loadInstallations={async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('HTTP 500');
          return { installations: [installation()] };
        }}
      />,
    );
    const retry = await screen.findByText('暂时无法加载，点此重试');
    expect(screen.queryByText(/HTTP|500|error/i)).toBeNull();
    await userEvent.click(retry);
    expect(await screen.findByTestId('apps-nav-inst-1')).not.toBeNull();
  });

  it('点击写入壳 URL 并派发 popstate', async () => {
    let popstates = 0;
    const handler = () => {
      popstates += 1;
    };
    window.addEventListener('popstate', handler);
    try {
      render(
        <AppsSidebarPanel loadInstallations={async () => ({ installations: [installation()] })} />,
      );
      await userEvent.click(await screen.findByTestId('apps-nav-inst-1'));
      expect(window.location.pathname).toBe('/apps/inst-1');
      expect(popstates).toBe(1);
    } finally {
      window.removeEventListener('popstate', handler);
    }
  });

  it('选中态以 URL 为准：同一 apps 标签下只有当前安装实例高亮', async () => {
    window.history.replaceState({}, '', '/apps/inst-2/orders');
    render(
      <AppsSidebarPanel
        loadInstallations={async () => ({
          installations: [
            installation(),
            installation({ installationId: 'inst-2', systemId: 'wms', name: '仓库' }),
          ],
        })}
      />,
    );
    const selected = await screen.findByTestId('apps-nav-inst-2');
    expect(selected.className).toContain('bg-brand-accent-soft');
    expect(screen.getByTestId('apps-nav-inst-1').className).not.toContain('bg-brand-accent-soft');
  });
});
