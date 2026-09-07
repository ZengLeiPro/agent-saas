import { afterEach, describe, expect, it } from 'vitest';
import type { PgEntitlementStore } from '../../data/entitlements/store.js';
import {
  createKyAppTestRig,
  seedPublishedInstallation,
  ORG_ADMIN,
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
