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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baseNavItems, getSidebarNavItems } from '@/types/sidebar';
import { __setMySystemsLoaderForTests } from '@/lib/mySystemsSource';
import type { MySystemInstallation, MySystemsResponse } from '@/lib/systemsApi';
import {
  APPS_NAV_UNAVAILABLE_MARK,
  AppsSidebarPanel,
  appsNavStateMark,
  buildAppsNavItems,
  isRenderableIconGlyph,
} from './AppsSidebarPanel';

function installation(overrides: Partial<MySystemInstallation> = {}): MySystemInstallation {
  return {
    installationId: 'inst-1',
    systemId: 'crm',
    name: '客户管理',
    icon: '📦',
    origin: 'https://t1-crm.apps.example.com',
    state: 'enabled',
    externalLinkHosts: [],
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
      {
        tab: 'apps',
        installationId: 'inst-1',
        label: '客户管理',
        icon: '📦',
        state: 'enabled',
        openable: true,
      },
      {
        tab: 'apps',
        installationId: 'inst-2',
        label: '仓库',
        icon: null,
        state: 'enabled',
        openable: true,
      },
    ]);
  });

  it('名称为空时回落 systemId', () => {
    expect(buildAppsNavItems([installation({ name: '' })])[0].label).toBe('crm');
  });

  it('空列表产出空数组', () => {
    expect(buildAppsNavItems([])).toEqual([]);
  });

  // §5.5「`live` 失败/停用 → 标签保留『暂不可用』」/ §6.6「系统被停用 → 标签『暂不可用』」。
  // 这条钉的是回归：曾经的实现把非 enabled 实例在服务端就滤掉，标签整项从侧边栏消失。
  it.each(['disabled', 'unavailable', 'maintenance', 'needs_reregistration'] as const)(
    '%s 的实例仍然产出一条标签，且带得出《系统名》',
    (state) => {
      const items = buildAppsNavItems([installation({ state })]);
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('客户管理');
      expect(items[0].openable).toBe(false);
    },
  );

  it('只有 disabled / unavailable 标「暂不可用」，更新中不标（§6.6 给的是条幅）', () => {
    expect(appsNavStateMark('enabled')).toBeNull();
    expect(appsNavStateMark('disabled')).toBe(APPS_NAV_UNAVAILABLE_MARK);
    expect(appsNavStateMark('unavailable')).toBe(APPS_NAV_UNAVAILABLE_MARK);
    expect(appsNavStateMark('maintenance')).toBeNull();
    expect(appsNavStateMark('needs_reregistration')).toBeNull();
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
  // 取数走壳内单一来源（`lib/mySystemsSource.ts`），测试从那里注入替身：
  // 这样「左栏与 AppHost 共享同一次 GET」这条不变量在测试里也成立。
  function useLoader(loader: () => Promise<MySystemsResponse>): void {
    __setMySystemsLoaderForTests(loader);
  }

  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    __setMySystemsLoaderForTests(null);
  });

  it('渲染每个安装实例一项', async () => {
    useLoader(async () => ({
      installations: [
        installation(),
        installation({ installationId: 'inst-2', systemId: 'wms', name: '仓库' }),
      ],
    }));
    render(<AppsSidebarPanel />);
    expect((await screen.findByTestId('apps-nav-inst-1')).textContent).toContain('客户管理');
    expect(screen.getByTestId('apps-nav-inst-2').textContent).toContain('仓库');
  });

  it('没有可见系统时整块不渲染（含 /api/systems/mine 404 → 空列表）', async () => {
    useLoader(async () => ({ installations: [] }));
    const { container } = render(<AppsSidebarPanel />);
    await waitFor(() => expect(container.querySelector('nav')).toBeNull());
  });

  it('拉取失败只给客户面文案与重试，不写技术归因', async () => {
    let attempts = 0;
    useLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('HTTP 500');
      return { installations: [installation()] };
    });
    render(<AppsSidebarPanel />);
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
      useLoader(async () => ({ installations: [installation()] }));
      render(<AppsSidebarPanel />);
      await userEvent.click(await screen.findByTestId('apps-nav-inst-1'));
      expect(window.location.pathname).toBe('/apps/inst-1');
      expect(popstates).toBe(1);
    } finally {
      window.removeEventListener('popstate', handler);
    }
  });

  it('系统停用后标签不消失：仍显示《系统名》+「暂不可用」', async () => {
    useLoader(async () => ({
      installations: [
        installation({ state: 'disabled' }),
        installation({ installationId: 'inst-2', systemId: 'wms', name: '仓储管理' }),
      ],
    }));
    render(<AppsSidebarPanel />);
    const row = await screen.findByTestId('apps-nav-inst-1');
    expect(row.textContent).toContain('客户管理');
    expect(row.textContent).toContain(APPS_NAV_UNAVAILABLE_MARK);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    // 另一项照常，且没有任何技术归因字样
    expect(screen.getByTestId('apps-nav-inst-2').textContent).toContain('仓储管理');
    expect(screen.queryByText(/停用|disabled|403|HTTP/i)).toBeNull();
  });

  it('选中态以 URL 为准：同一 apps 标签下只有当前安装实例高亮', async () => {
    window.history.replaceState({}, '', '/apps/inst-2/orders');
    useLoader(async () => ({
      installations: [
        installation(),
        installation({ installationId: 'inst-2', systemId: 'wms', name: '仓库' }),
      ],
    }));
    render(<AppsSidebarPanel />);
    const selected = await screen.findByTestId('apps-nav-inst-2');
    expect(selected.className).toContain('bg-brand-accent-soft');
    expect(screen.getByTestId('apps-nav-inst-1').className).not.toContain('bg-brand-accent-soft');
  });
});
