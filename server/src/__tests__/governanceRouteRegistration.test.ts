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

  it('把 runtime TenantStore strict authority 传入实际 UI route 并可自动构造 management endpoint', async () => {
    const now = '2026-08-25T18:00:00.000Z';
    const findById = vi.fn(() => { throw new Error('non-strict tenant read must not be used'); });
    const findByIdStrict = vi.fn((id: string) => id === 'tenant-a' ? {
      id, name: id, createdAt: now, createdBy: 'system', updatedAt: now,
    } : undefined);
    const auditAppend = vi.fn(async (value: object) => ({ auditId: 'audit-1', ...value }));
    const runtime = {
      config: { auth: { jwtSecret: 'test-secret' } },
      userStore: { findById: (id: string) => id === 'user-1' ? {
        id, tenantId: 'tenant-a', username: id, role: 'user' as const, passwordHash: 'x',
        createdAt: now, createdBy: 'system', updatedAt: now,
      } : undefined },
      tenantStore: { findById, findByIdStrict },
      membershipStore: {
        getMembership: vi.fn(async (tenantId: string, userId: string) => ({
          tenantId, userId, persona: 'member' as const, isOwner: false, status: 'active' as const,
          source: 'governance' as const, version: 3, createdAt: now, createdBy: 'system',
          updatedAt: now, updatedBy: 'system',
        })),
        getPlatformAdmin: vi.fn(async () => null),
      },
      governanceAuditStore: { append: auditAppend },
    };

    registerGovernanceRoutes(express(), runtime as never, {});

    const wiredDeps = mocks.ui.mock.calls[0]?.[0];
    expect(wiredDeps).toMatchObject({ tenants: { findByIdStrict } });
    const actual = await vi.importActual<typeof import('../routes/governanceUi.js')>('../routes/governanceUi.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: 'user-1', username: 'user-1', tenantId: 'tenant-a', role: 'user' };
      next();
    });
    app.use(actual.createGovernanceUiRouter(wiredDeps as never));
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/api/access/management-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: [{ action: 'settings.personal.view', scope: { kind: 'personal' } }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ subject: { userId: 'user-1', persona: 'member' } });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(findByIdStrict).toHaveBeenCalledWith('tenant-a');
    expect(findById).not.toHaveBeenCalled();
    expect(auditAppend.mock.calls.map(call => (call[0] as { result: string }).result)).toEqual(['intent', 'succeeded']);
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
