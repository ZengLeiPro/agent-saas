import { describe, expect, it, vi } from 'vitest';

import { governanceRoute } from '@/lib/governanceNavigation';
import { ORGANIZATION_MANAGEMENT_RENDERERS } from './OrganizationManagementContent';

function context(routeId: 'organization.agents.files-data' | 'organization.governance.automation') {
  return {
    route: governanceRoute(routeId, { orgId: 'tenant-b' }),
    tenantId: 'tenant-b',
    tenantName: '乙组织',
    renderAccounts: vi.fn(),
    renderSkills: vi.fn(),
    renderMcpCatalog: vi.fn(),
    renderUsage: vi.fn(),
    renderFiles: vi.fn(),
    renderCompanyInfo: vi.fn(),
    renderAutomation: vi.fn(),
  };
}

describe('OrganizationManagementContent target scope', () => {
  it.each([
    ['organization.agents.files-data', 'renderFiles'],
    ['organization.governance.automation', 'renderAutomation'],
  ] as const)('%s 始终向 renderer 传递目标组织', (routeId, rendererName) => {
    const props = context(routeId);
    ORGANIZATION_MANAGEMENT_RENDERERS[routeId](props);
    expect(props[rendererName]).toHaveBeenCalledWith('tenant-b', '乙组织');
  });
});
