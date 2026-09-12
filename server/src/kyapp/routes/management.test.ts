import { afterEach, describe, expect, it } from 'vitest';
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
async function rig() {
  const result = await createKyAppTestRig({});
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
  it('组织权益不再拦截：组织管理员可安装已发布系统', async () => {
    const app = await rig();
    app.setUser(ORG_ADMIN);
    const list = await app.request(
      `/api/app-contract/v1/systems/installable?tenantId=${TEST_TENANT}`,
    );
    expect(list.status).toBe(200);
    expect((await list.json()).systems).toHaveLength(1);
    expect(
      (await app.request('/api/app-contract/v1/installations', json('POST', body))).status,
    ).toBe(201);
  });
  it('成员、其他组织均拒绝', async () => {
    const app = await rig();
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
