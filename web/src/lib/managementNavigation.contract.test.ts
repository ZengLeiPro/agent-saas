import { describe, expect, it } from 'vitest';

import { GOVERNANCE_ROUTES, governanceRoute } from '@/lib/governanceNavigation';
import {
  MANAGEMENT_PAGES,
  activeManagementTab,
  managementPageForRoute,
  managementPagesFor,
  managementRouteForPage,
  managementRouteForTab,
} from '@/lib/managementNavigation';

describe('管理后台导航契约', () => {
  it('页面 ID 唯一且所有 routeId 都来自治理路由事实源', () => {
    const routeIds = new Set(GOVERNANCE_ROUTES.map((route) => route.id));
    expect(new Set(MANAGEMENT_PAGES.map((page) => page.id)).size).toBe(MANAGEMENT_PAGES.length);
    for (const page of MANAGEMENT_PAGES) {
      expect(routeIds.has(page.routeId), page.id).toBe(true);
      for (const alias of page.aliases ?? [])
        expect(routeIds.has(alias), `${page.id}/${alias}`).toBe(true);
      for (const item of page.tabs ?? [])
        expect(routeIds.has(item.routeId), `${page.id}/${item.id}`).toBe(true);
    }
  });

  it('配置面固定为组织 17 项、平台 12 项', () => {
    expect(managementPagesFor('config', 'organization')).toHaveLength(17);
    expect(managementPagesFor('config', 'platform')).toHaveLength(12);
  });

  it('分析面只注册有真实页面的组织 4 项、平台 9 项', () => {
    expect(managementPagesFor('analytics', 'organization')).toHaveLength(4);
    expect(managementPagesFor('analytics', 'platform')).toHaveLength(9);
  });

  it('同一用量路由按 URL 语义拆为分析与预算配置', () => {
    const usage = governanceRoute('organization.governance.usage', { orgId: 'kaiyan' });
    const budget = governanceRoute('organization.governance.usage', {
      orgId: 'kaiyan',
      search: '?usageSection=billing',
    });
    expect(managementPageForRoute(usage)?.id).toBe('org-usage');
    expect(managementPageForRoute(budget)?.id).toBe('org-budget');
  });

  it('合并页的 Tab 导航保留组织作用域并可反向识别', () => {
    const page = MANAGEMENT_PAGES.find((item) => item.id === 'org-connectors')!;
    const initial = managementRouteForPage(page, null, 'kaiyan');
    const mcp = managementRouteForTab(page, 'mcp', initial);
    expect(mcp).toMatchObject({ routeId: 'organization.agents.mcp-catalog', orgId: 'kaiyan' });
    expect(managementPageForRoute(mcp)?.id).toBe(page.id);
    expect(activeManagementTab(page, mcp)?.id).toBe('mcp');
  });
});
