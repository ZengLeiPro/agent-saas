import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  managementSnapshotResponseV1Schema,
  type ManagementSnapshotRequestV1,
  type ManagementSnapshotResponseV1,
} from '../../../shared/src/types/governance.js';
import type { JwtPayload } from '../auth/types.js';
import { createGovernanceUiRouter } from '../routes/governanceUi.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

const command = { decisions: [{ action: 'settings.personal.view' as const, scope: { kind: 'personal' as const } }] };
const snapshot: ManagementSnapshotResponseV1 = {
  contractVersion: 'v1' as const,
  subject: { userId: 'user-1', tenantId: 'tenant-a', persona: 'member' as const, isOwner: false },
  decisions: [{
    ...command.decisions[0], allowed: true,
    reason: { code: 'PERSONAL_SELF_ALLOWED', label: '允许查看本人的个人设置', layer: 'management_scope' },
    constraints: ['SELF_ONLY' as const],
  }],
  policySnapshot: { membershipVersion: 3 },
  evaluatedAt: '2026-08-25T18:00:00.000Z',
};

async function appRequest(input: {
  jwt?: JwtPayload | null;
  createSnapshot?: (
    actorUserId: string,
    input: ManagementSnapshotRequestV1,
  ) => Promise<ManagementSnapshotResponseV1>;
  withService?: boolean;
  productionDeps?: boolean;
  strictTenantFailure?: boolean;
  omitStrictTenantAuthority?: boolean;
} = {}) {
  const app = express();
  app.use(express.json());
  if (input.jwt !== null) {
    const jwt = input.jwt ?? { sub: 'user-1', username: 'user-1', tenantId: 'tenant-a', role: 'user' };
    app.use((req, _res, next) => { req.user = jwt; next(); });
  }
  const createSnapshot = input.createSnapshot ?? vi.fn(async (
    _actorUserId: string,
    _input: ManagementSnapshotRequestV1,
  ): Promise<ManagementSnapshotResponseV1> => snapshot);
  const productionDeps = {
    users: { findById: (id: string) => id === 'user-1' ? {
      id, tenantId: 'tenant-a', username: id, role: 'user' as const, passwordHash: 'x',
      createdAt: snapshot.evaluatedAt, createdBy: 'system', updatedAt: snapshot.evaluatedAt,
    } : undefined },
    tenants: {
      findById: (id: string) => id === 'tenant-a' ? {
        id, name: id, createdAt: snapshot.evaluatedAt, createdBy: 'system', updatedAt: snapshot.evaluatedAt,
      } : undefined,
      ...(!input.omitStrictTenantAuthority ? {
        findByIdStrict: (id: string) => {
          if (input.strictTenantFailure) throw new Error('strict tenant store down');
          return id === 'tenant-a' ? {
            id, name: id, createdAt: snapshot.evaluatedAt, createdBy: 'system', updatedAt: snapshot.evaluatedAt,
          } : undefined;
        },
      } : {}),
    },
    memberships: {
      getMembership: vi.fn(async (tenantId: string, userId: string) => tenantId === 'tenant-a' && userId === 'user-1' ? {
        tenantId, userId, persona: 'member' as const, isOwner: false, status: 'active' as const,
        source: 'governance' as const, version: 3, createdAt: snapshot.evaluatedAt, createdBy: 'system',
        updatedAt: snapshot.evaluatedAt, updatedBy: 'system',
      } : null),
      getPlatformAdmin: vi.fn(async () => null),
    },
    audit: { append: vi.fn(async (value: object) => ({ auditId: 'audit-production', ...value })) },
    now: () => new Date(snapshot.evaluatedAt),
  };
  const deps = input.productionDeps
    ? productionDeps
    : input.withService === false ? {} : { managementSnapshotService: { createSnapshot } };
  app.use(createGovernanceUiRouter(deps as never));
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return {
    createSnapshot,
    post: (body: unknown) => fetch(`${base}/api/access/management-snapshot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
}

describe('POST /api/access/management-snapshot', () => {
  it('调用注入的独立 service、assertSafe 并返回严格 v1 DTO', async () => {
    const rig = await appRequest();
    const response = await rig.post(command);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(managementSnapshotResponseV1Schema.parse(body)).toEqual(snapshot);
    expect(rig.createSnapshot).toHaveBeenCalledWith('user-1', command);
    expect(JSON.stringify(body)).not.toMatch(/secret|token|password|externalAccount/i);
  });

  it('未注入 management service 时可用完整生产依赖自动装配并工作', async () => {
    const rig = await appRequest({ productionDeps: true });
    const response = await rig.post(command);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(rig.createSnapshot).not.toHaveBeenCalled();
  });

  it('生产依赖缺少 strict tenant authority 时不自动装配 management service', async () => {
    const rig = await appRequest({ productionDeps: true, omitStrictTenantAuthority: true });
    const response = await rig.post(command);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE' });
  });

  it('生产装配的 strict tenant authority 读取异常返回 503 而非 404/deny', async () => {
    const rig = await appRequest({ productionDeps: true, strictTenantFailure: true });
    const response = await rig.post(command);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE' });
  });

  it('未登录、依赖缺失、未知动作、错 scope 结构和超量均 fail closed', async () => {
    const anonymous = await appRequest({ jwt: null });
    expect((await anonymous.post(command)).status).toBe(401);

    const unavailable = await appRequest({ withService: false });
    expect((await unavailable.post(command)).status).toBe(503);

    const rig = await appRequest();
    for (const invalid of [
      { decisions: [{ action: 'settings.unknown.view', scope: { kind: 'personal' } }] },
      { decisions: [{ action: 'settings.tenant.view', scope: { kind: 'tenant' } }] },
      { decisions: Array.from({ length: 65 }, () => command.decisions[0]) },
    ]) {
      const response = await rig.post(invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'INVALID_MANAGEMENT_SNAPSHOT_REQUEST' });
    }
    expect(rig.createSnapshot).not.toHaveBeenCalled();
  });

  it('拒绝注入 service 返回的敏感字段，且不会将快照当作写接口令牌', async () => {
    const unsafe = vi.fn(async () => ({ ...snapshot, token: 'must-not-leak' }));
    const rig = await appRequest({ createSnapshot: unsafe });
    const response = await rig.post(command);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'UNSAFE_GOVERNANCE_DTO' });

    expect(command).toEqual({
      decisions: [{ action: 'settings.personal.view', scope: { kind: 'personal' } }],
    });
    expect(snapshot).not.toHaveProperty('authorizationToken');
    expect(snapshot).not.toHaveProperty('changeReceipt');
  });
});
