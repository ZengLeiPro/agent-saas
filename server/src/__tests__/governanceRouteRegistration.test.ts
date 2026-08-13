import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  ui: vi.fn(),
  resources: vi.fn(),
}));

vi.mock('../routes/governanceAccess.js', () => ({ createGovernanceAccessRouter: mocks.access }));
vi.mock('../routes/governanceUi.js', () => ({ createGovernanceUiRouter: mocks.ui }));
vi.mock('../routes/governanceResources.js', () => ({ createGovernanceResourcesRouter: mocks.resources }));

import { registerGovernanceRoutes } from '../app/governanceRoutes.js';

describe('registerGovernanceRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockReturnValue(express.Router());
    mocks.ui.mockReturnValue(express.Router());
    mocks.resources.mockReturnValue(express.Router());
  });

  it('把 runtime directoryGroupStore 传给 access router，目录群组不再因装配缺失返回 503', () => {
    const directoryGroupStore = {
      getGroup: vi.fn(),
      listGroups: vi.fn(),
      getAssignmentSnapshot: vi.fn(),
    };
    const runtime = {
      config: { auth: { jwtSecret: 'test-secret' } },
      userStore: {},
      tenantStore: {},
      membershipStore: {},
      entitlementStore: {},
      assignmentStore: {},
      governanceAuditStore: {},
      governanceProjectionOutboxStore: {},
      directoryGroupStore,
    };

    registerGovernanceRoutes(express(), runtime as never, {});

    expect(mocks.access).toHaveBeenCalledTimes(1);
    expect(mocks.access.mock.calls[0]?.[0]).toMatchObject({ directoryGroups: directoryGroupStore });
  });
});
