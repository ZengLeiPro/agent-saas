import { describe, expect, it } from 'vitest';

import { ORGANIZATION_MANAGEMENT_RENDERERS } from './OrganizationManagementContent';
import {
  ORGANIZATION_MANAGEMENT_ROUTE_IDS,
  ORGANIZATION_SETTINGS_WORKSPACES,
} from './organizationManagementRegistry';
import {
  activeOrganizationLocalRouteId,
  organizationLocalRouteDefinitions,
  organizationWorkspaceRoute,
} from './organizationManagementRouting';
import { governanceRoute } from '@/lib/governanceNavigation';

describe('organization management registry', () => {
  it('固定五个分类、默认页和 27 个主页面加成员详情', () => {
    expect(
      ORGANIZATION_SETTINGS_WORKSPACES.map(({ id, label, defaultRouteId }) => ({
        id,
        label,
        defaultRouteId,
      })),
    ).toEqual([
      { id: 'overview', label: '组织总览', defaultRouteId: 'organization.overview.overview' },
      { id: 'members', label: '成员与权限', defaultRouteId: 'organization.members.list' },
      { id: 'agents', label: '智能体与资源', defaultRouteId: 'organization.agents.org-agents' },
      { id: 'governance', label: '用量与治理', defaultRouteId: 'organization.governance.usage' },
      { id: 'settings', label: '组织设置', defaultRouteId: 'organization.settings.profile' },
    ]);
    expect(ORGANIZATION_MANAGEMENT_ROUTE_IDS).toHaveLength(28);
    expect(new Set(ORGANIZATION_MANAGEMENT_ROUTE_IDS).size).toBe(28);
  });

  it('每条组织 route 恰有一个权威 renderer', () => {
    expect(Object.keys(ORGANIZATION_MANAGEMENT_RENDERERS).sort()).toEqual(
      [...ORGANIZATION_MANAGEMENT_ROUTE_IDS].sort(),
    );
  });

  it('成员详情激活成员叶；分类跳转保留 org 且清除页面私有状态', () => {
    const detail = governanceRoute('organization.members.member', {
      orgId: 'acme',
      entityId: 'u1',
      tab: 'security-audit',
      search: '?status=active',
    });
    expect(activeOrganizationLocalRouteId(detail)).toBe('organization.members.list');
    expect(organizationLocalRouteDefinitions(detail).map((route) => route.id)).not.toContain(
      'organization.members.member',
    );
    expect(organizationWorkspaceRoute('agents', detail)).toMatchObject({
      routeId: 'organization.agents.org-agents',
      orgId: 'acme',
      entityId: null,
      tab: null,
      search: '',
    });
  });

  it('移动端返回设置菜单后仍使用已记住的平台管理员目标组织', () => {
    expect(organizationWorkspaceRoute('governance', null, 'tenant-a')).toMatchObject({
      routeId: 'organization.governance.usage',
      orgId: 'tenant-a',
    });
  });
});
