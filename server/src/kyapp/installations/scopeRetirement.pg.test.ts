import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManagementPgFixture } from '../__tests__/managementPgFixture.js';
import { buildManifest, MEMBER, TEST_TENANT } from '../__tests__/harness.js';

const url = process.env.TEST_DATABASE_URL;
const base = '/api/app-contract/v1';
(url ? describe : describe.skip)('组织安装白名单退役：真实 HTTP / PostgreSQL', () => {
  let rig: Awaited<ReturnType<typeof createManagementPgFixture>>;
  let sequence = 0;
  beforeAll(async () => {
    rig = await createManagementPgFixture(url!);
  }, 30_000);
  afterAll(async () => {
    await rig?.close();
  }, 30_000);

  async function system(published = true) {
    const systemId = `scope-test-${++sequence}`;
    const uploaded = await rig.request(`${base}/systems/${systemId}/versions`, 'platform', 'POST', {
      name: '范围退役验收',
      manifest: buildManifest({ systemId }),
    });
    expect(uploaded.status).toBe(201);
    const { definition, version } = await uploaded.json();
    if (published) {
      const response = await rig.request(
        `${base}/systems/${systemId}/versions/${version.digest}/publish`,
        'platform',
        'POST',
        {
          expectedVersion: definition.version,
        },
      );
      expect(response.status).toBe(200);
    }
    return {
      systemId,
      tenantId: TEST_TENANT,
      installationId: `${systemId}-instance`,
      baseUrl: 'http://127.0.0.1:4195',
      origin: 'http://127.0.0.1:4195',
      techContactUserId: MEMBER.sub,
    };
  }

  it.each(['absent', 'empty', 'other-system', 'all'] as const)(
    '历史范围 %s 不再过滤候选或阻止组织管理员安装，也不会被扩大或删除',
    async (legacy) => {
      const body = await system();
      await rig.pool.query(
        `DELETE FROM ${rig.entitlements.scopesTable}
        WHERE tenant_id=$1 AND resource_type='integrated_system'`,
        [TEST_TENANT],
      );
      if (legacy !== 'absent') {
        await rig.pool.query(
          `INSERT INTO ${rig.entitlements.scopesTable}
          (tenant_id,resource_type,mode,source,version,created_by,updated_by)
          VALUES ($1,'integrated_system',$2,'governance',7,'legacy','legacy')`,
          [TEST_TENANT, legacy === 'all' ? 'all' : 'selected'],
        );
        if (legacy === 'other-system')
          await rig.pool.query(
            `INSERT INTO ${rig.entitlements.itemsTable}
          (tenant_id,resource_type,resource_id,source,created_by)
          VALUES ($1,'integrated_system','not-this-system','governance','legacy')`,
            [TEST_TENANT],
          );
      }
      const before = await rig.entitlements.listResourceScopes(TEST_TENANT);
      const list = await rig.request(`${base}/systems/installable?tenantId=${TEST_TENANT}`, 'org');
      expect(list.status).toBe(200);
      expect((await list.json()).systems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ systemId: body.systemId, allowedActions: ['install'] }),
        ]),
      );
      const created = await rig.request(`${base}/installations`, 'org', 'POST', body);
      expect(created.status).toBe(201);
      expect((await created.json()).installation).toMatchObject({
        installationId: body.installationId,
        tenantId: TEST_TENANT,
        status: 'pending',
      });
      expect(await rig.entitlements.listResourceScopes(TEST_TENANT)).toEqual(before);
      expect(
        await rig.assignments.getAssignmentSet(
          TEST_TENANT,
          'system_installation',
          body.installationId,
        ),
      ).toBeNull();
      // 安装不是使用授权；不能向普通成员发放 token 或泄露业务页面入口。
      expect(
        (
          await rig.request(
            `${base}/installations/${body.installationId}/token`,
            'unassigned',
            'POST',
          )
        ).status,
      ).toBe(403);
      expect(
        (await (await rig.request('/api/systems/mine', 'unassigned')).json()).installations,
      ).toEqual([]);
    },
  );

  it('缺少旧范围也不放宽匿名、普通成员及跨组织创建权限', async () => {
    const body = await system();
    for (const identity of ['member', 'other'] as const) {
      expect((await rig.request(`${base}/installations`, identity, 'POST', body)).status).toBe(403);
      expect(
        (await rig.request(`${base}/systems/installable?tenantId=${TEST_TENANT}`, identity)).status,
      ).toBe(403);
    }
    const anonymous = await fetch(`${rig.origin}${base}/installations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(anonymous.status).toBe(403);
    expect(await rig.assembly.systems.getInstallation(body.installationId)).toBeNull();
  });

  it.each(['draft', 'disabled', 'retired'] as const)(
    '未发布状态 %s 仍不能安装，候选列表同样排除',
    async (status) => {
      const body = await system(false);
      if (status !== 'draft')
        await rig.pool.query(
          `UPDATE ${rig.assembly.systems.definitionsTable}
      SET status=$2 WHERE system_id=$1`,
          [body.systemId, status],
        );
      const list = await rig.request(`${base}/systems/installable?tenantId=${TEST_TENANT}`, 'org');
      expect(
        (await list.json()).systems.some(
          (item: { systemId: string }) => item.systemId === body.systemId,
        ),
      ).toBe(false);
      expect((await rig.request(`${base}/installations`, 'org', 'POST', body)).status).toBe(409);
      expect(await rig.assembly.systems.getInstallation(body.installationId)).toBeNull();
    },
  );

  it.each(['missing-user', 'u_other'])(
    '未知或其他组织联系人 %s 仍在写入前被拒绝',
    async (techContactUserId) => {
      const body = { ...(await system()), techContactUserId };
      expect((await rig.request(`${base}/installations`, 'org', 'POST', body)).status).toBe(409);
      expect(await rig.assembly.systems.getInstallation(body.installationId)).toBeNull();
    },
  );
});
