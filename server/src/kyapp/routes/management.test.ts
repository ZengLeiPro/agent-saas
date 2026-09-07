import { afterEach, describe, expect, it } from 'vitest';
import type { PgEntitlementStore } from '../../data/entitlements/store.js';
import {
  createKyAppTestRig,
  seedPublishedInstallation,
  ORG_ADMIN,
  PLATFORM_ADMIN,
  buildManifest,
  MEMBER,
  OTHER_TENANT_ADMIN,
  TEST_TENANT,
  TEST_SYSTEM,
  TEST_ORIGIN,
  json,
  type KyAppTestRig,
} from '../__tests__/harness.js';
const rigs: KyAppTestRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.close()));
});
const scope = (status: string, ids: string[]) =>
  ({
    getEntitlementSet: async () => ({ status }),
    listResourceScopes: async () => [
      { resourceType: 'integrated_system', mode: 'selected', resourceIds: ids },
    ],
  }) as unknown as PgEntitlementStore;
async function rig(entitlements?: PgEntitlementStore) {
  const result = await createKyAppTestRig(entitlements ? { entitlements } : {});
  rigs.push(result);
  await seedPublishedInstallation(result);
  return result;
}
const body = {
  installationId: 'second-install',
  tenantId: TEST_TENANT,
  systemId: TEST_SYSTEM,
  baseUrl: TEST_ORIGIN,
  origin: TEST_ORIGIN,
  techContactUserId: MEMBER.sub,
};
describe('业务系统组织安装 HTTP 权限', () => {
  it.each([
    ['active', [TEST_SYSTEM], 201],
    ['active', [], 403],
    ['suspended', [TEST_SYSTEM], 403],
  ] as const)('%s %j → %i', async (status, ids, expected) => {
    const app = await rig(scope(status, [...ids]));
    app.setUser(ORG_ADMIN);
    const list = await app.request(
      `/api/app-contract/v1/systems/installable?tenantId=${TEST_TENANT}`,
    );
    expect(list.status).toBe(200);
    expect((await list.json()).systems).toHaveLength(expected === 201 ? 1 : 0);
    expect(
      (await app.request('/api/app-contract/v1/installations', json('POST', body))).status,
    ).toBe(expected);
  });
  it('依赖不可用不写入，成员、其他组织均拒绝', async () => {
    const app = await rig();
    app.setUser(ORG_ADMIN);
    expect(
      (await app.request('/api/app-contract/v1/installations', json('POST', body))).status,
    ).toBe(503);
    for (const identity of [MEMBER, OTHER_TENANT_ADMIN]) {
      app.setUser(identity);
      expect(
        (await app.request('/api/app-contract/v1/installations', json('POST', body))).status,
      ).toBe(403);
      expect(
        (await app.request(`/api/app-contract/v1/installations?tenantId=${TEST_TENANT}`)).status,
      ).toBe(403);
      expect(
        (await app.request(`/api/app-contract/v1/systems/installable?tenantId=${TEST_TENANT}`))
          .status,
      ).toBe(403);
    }
  });
});

describe('管理员直接发布系统版本', () => {
  it('首版无需复核；成员和组织管理员仍无权发布', async () => {
    const app = await createKyAppTestRig({ toolRegistrationDryRun: async () => {} });
    rigs.push(app);
    app.setUser(PLATFORM_ADMIN);
    const registered = await app.request(
      `/api/app-contract/v1/systems/${TEST_SYSTEM}/versions`,
      json('POST', { name: '演示', manifest: buildManifest() }),
    );
    expect(registered.status).toBe(201);
    const data = await registered.json();
    expect(data.version.reviewStatus).toBe('not_required');
    const path = `/api/app-contract/v1/systems/${TEST_SYSTEM}/versions/${data.version.digest}/publish`;
    for (const actor of [MEMBER, ORG_ADMIN]) {
      app.setUser(actor);
      expect(
        (await app.request(path, json('POST', { expectedVersion: data.definition.version })))
          .status,
      ).toBe(403);
    }
    app.setUser(PLATFORM_ADMIN);
    const result = await app.request(
      path,
      json('POST', { expectedVersion: data.definition.version }),
    );
    expect(result.status).toBe(200);
    expect((await result.json()).gate.toolRegistrationDryRun.status).toBe('passed');
    expect(
      (await app.request(path, json('POST', { expectedVersion: data.definition.version }))).status,
    ).toBe(409);
  });
  it('工具注册失败仍阻止发布', async () => {
    const app = await createKyAppTestRig({
      toolRegistrationDryRun: async () => {
        throw new Error('注册失败');
      },
    });
    rigs.push(app);
    app.setUser(PLATFORM_ADMIN);
    const result = await app.request(
      `/api/app-contract/v1/systems/${TEST_SYSTEM}/versions`,
      json('POST', { name: '演示', manifest: buildManifest() }),
    );
    const data = await result.json();
    expect(
      (
        await app.request(
          `/api/app-contract/v1/systems/${TEST_SYSTEM}/versions/${data.version.digest}/publish`,
          json('POST', { expectedVersion: data.definition.version }),
        )
      ).status,
    ).toBe(409);
  });
});
