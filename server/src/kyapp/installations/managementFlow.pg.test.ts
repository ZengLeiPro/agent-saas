import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManagementPgFixture } from '../__tests__/managementPgFixture.js';
import { buildManifest, TEST_SYSTEM, TEST_TENANT, MEMBER } from '../__tests__/harness.js';
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('P0 真实 HTTP 与 PostgreSQL 管理链路', () => {
  let rig: Awaited<ReturnType<typeof createManagementPgFixture>>;
  beforeAll(async () => {
    rig = await createManagementPgFixture(url!);
  });
  afterAll(async () => {
    await rig?.close();
  });
  it('发布、组织安装、一次领取、成员授权和停用范围回读', async () => {
    const base = '/api/app-contract/v1';
    const uploaded = await rig.request(
      `${base}/systems/${TEST_SYSTEM}/versions`,
      'platform',
      'POST',
      { name: '验收订单系统', manifest: buildManifest() },
    );
    expect(uploaded.status).toBe(201);
    const { definition, version } = await uploaded.json();
    expect(
      (
        await rig.request(
          `${base}/systems/${TEST_SYSTEM}/versions/${version.digest}/publish`,
          'platform',
          'POST',
          { expectedVersion: definition.version },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await rig.request(
          `${base}/systems/${TEST_SYSTEM}/versions/${version.digest}/review`,
          'reviewer',
          'POST',
        )
      ).status,
    ).toBe(200);
    const published = await rig.request(
      `${base}/systems/${TEST_SYSTEM}/versions/${version.digest}/publish`,
      'platform',
      'POST',
      { expectedVersion: definition.version },
    );
    expect(published.status, JSON.stringify(await published.json())).toBe(200);
    const scope = (await rig.entitlements.listResourceScopes(TEST_TENANT)).find(
      (item) => item.resourceType === 'integrated_system',
    )!;
    await rig.entitlements.replaceResourceScope(TEST_TENANT, 'integrated_system', {
      mode: 'selected',
      resourceIds: [TEST_SYSTEM],
      expectedVersion: scope.version,
      updatedBy: 'fixture',
    });
    const iid = 'e2e-business-system-tenant-a';
    const installationInput = {
      installationId: iid,
      tenantId: TEST_TENANT,
      systemId: TEST_SYSTEM,
      baseUrl: 'http://127.0.0.1:4195',
      origin: 'http://127.0.0.1:4195',
      techContactUserId: MEMBER.sub,
    };
    expect(
      (await rig.request(`${base}/installations`, 'other', 'POST', installationInput)).status,
    ).toBe(403);
    expect(
      (await rig.request(`${base}/installations`, 'org', 'POST', installationInput)).status,
    ).toBe(201);
    expect((await rig.request(`${base}/installations/${iid}/management`, 'other')).status).toBe(
      403,
    );
    const issued = await rig.request(
      `${base}/installations/${iid}/credentials`,
      'platform',
      'POST',
    );
    expect(issued.status).toBe(201);
    const { credential: ticket } = await issued.json();
    const claimPath = `${base}/installations/${iid}/credentials/claim/${ticket.ticket}`;
    expect((await rig.request(claimPath, 'org')).status).toBe(403);
    const claimed = await rig.request(claimPath, 'member');
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get('cache-control')).toContain('no-store');
    const { credential } = await claimed.json();
    expect((await rig.request(claimPath, 'member')).status).toBe(409);
    const ack = await fetch(`${rig.origin}${base}/installations/${iid}/credential-ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.serviceCredential}` },
    });
    expect(ack.status).toBe(200);
    const metadata = await (
      await rig.request(`${base}/installations/${iid}/credentials`, 'org')
    ).json();
    expect(JSON.stringify(metadata)).not.toContain(credential.serviceCredential);
    expect(JSON.stringify(metadata)).not.toContain(credential.installationKey);
    // 外部 DNS 未在本地装配；这里只设置验证事实，不能作为真实 DNS 验收。
    await rig.pool.query(
      `UPDATE ${rig.assembly.systems.installationsTable} SET domain_verified_at=NOW() WHERE installation_id=$1`,
      [iid],
    );
    expect((await rig.request(`${base}/installations/${iid}/enable`, 'org', 'POST')).status).toBe(
      200,
    );
    expect((await (await rig.request('/api/systems/mine', 'member')).json()).installations).toEqual(
      [],
    );
    const set = await rig.assignments.getAssignmentSet(TEST_TENANT, 'system_installation', iid);
    await rig.assignments.replaceAssignments(
      TEST_TENANT,
      'system_installation',
      iid,
      [{ assigneeType: 'user', assigneeId: MEMBER.sub, effect: 'allow' }],
      set!.version,
      'fixture',
    );
    for (const state of ['enabled', 'disabled', 'enabled']) {
      if (state === 'disabled')
        await rig.request(`${base}/installations/${iid}/disable`, 'org', 'POST');
      else if ((await rig.assembly.systems.getInstallation(iid))?.status === 'disabled')
        await rig.request(`${base}/installations/${iid}/enable`, 'org', 'POST');
      expect(
        (await (await rig.request('/api/systems/mine', 'member')).json()).installations[0]?.state,
      ).toBe(state);
      expect(
        (await (await rig.request('/api/systems/mine', 'unassigned')).json()).installations,
      ).toEqual([]);
      expect(
        (
          await rig.assignments.listEffectiveResourceIds(
            TEST_TENANT,
            MEMBER.sub,
            'system_installation',
          )
        ).length,
      ).toBe(state === 'enabled' ? 1 : 0);
    }
    await rig.groups.upsertProjection({ tenantId: TEST_TENANT, groupId: 'sales', source: 'governance', displayName: '销售部', status: 'active', memberUserIds: [MEMBER.sub, 'unassigned'] });
    const current = await rig.assignments.getAssignmentSet(TEST_TENANT, 'system_installation', iid);
    await rig.assignments.replaceAssignments(TEST_TENANT, 'system_installation', iid, [
      { assigneeType: 'directory_group', assigneeId: 'sales', effect: 'allow' },
      { assigneeType: 'user', assigneeId: 'unassigned', effect: 'deny' },
      { assigneeType: 'agent', assigneeId: 'sales-agent', effect: 'allow' },
    ], current!.version, 'fixture');
    expect((await rig.assembly.assignmentAccess!.listEffectiveResourceIds(TEST_TENANT, MEMBER.sub, 'system_installation'))).toHaveLength(1);
    expect((await rig.assembly.assignmentAccess!.listEffectiveResourceIds(TEST_TENANT, 'unassigned', 'system_installation', 'sales-agent'))).toHaveLength(0);
    await rig.request(`${base}/installations/${iid}/disable`, 'org', 'POST');
    expect((await (await rig.request('/api/systems/mine', 'member')).json()).installations[0]?.state).toBe('disabled');
    expect((await (await rig.request('/api/systems/mine', 'unassigned')).json()).installations).toEqual([]);
    expect((await rig.assembly.assignmentAccess!.listEffectiveResourceIds(TEST_TENANT, MEMBER.sub, 'system_installation'))).toEqual([]);
    const summary = await (
      await rig.request(`${base}/installations/${iid}/management`, 'org')
    ).json();
    expect(summary.assignmentSummary).toMatchObject({ configured: true, ruleCount: 3 });
    expect(summary.credentialSummary).toHaveLength(1);
    expect((await rig.assembly.systems.getDefinition(TEST_SYSTEM))?.publishedDigest).toBe(
      version.digest,
    );
  });
});
