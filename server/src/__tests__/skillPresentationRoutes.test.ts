import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KAIYAN_USER,
  PLATFORM_ADMIN,
  WAIN_ADMIN,
  WAIN_USER,
  makeTestRig,
  type TestRig,
} from './skillsRouterTenantIsolation.testHelpers.js';

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function presentation(rig: TestRig, path: string, skillId = 'shared_skill') {
  const response = await rig.request(path);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    skills?: Array<{ id: string; presentation?: Record<string, unknown> }>;
    poolSkills?: Array<{ id: string; presentation?: Record<string, unknown> }>;
    tenantSkills?: Array<{ id: string; presentation?: Record<string, unknown> }>;
  };
  const skills = body.skills ?? [...(body.poolSkills ?? []), ...(body.tenantSkills ?? [])];
  return skills.find((skill) => skill.id === skillId)?.presentation;
}

describe('技能展示信息', () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = await makeTestRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('平台默认、组织覆盖与恢复按作用域继承，并使用乐观锁', async () => {
    rig.setCaller(PLATFORM_ADMIN);
    let response = await rig.request(
      '/api/skills/pool/shared_skill/presentation',
      json('PUT', {
        displayName: '平台共享技能',
        summary: '平台提供的默认中文说明',
        expectedRevision: 0,
      }),
    );
    expect(response.status).toBe(200);
    expect(await presentation(rig, '/api/skills/pool')).toMatchObject({
      displayName: '平台共享技能',
      source: 'platform_default',
      revision: 1,
    });

    rig.setCaller(WAIN_ADMIN);
    expect(await presentation(rig, '/api/skills/tenants/wain/pool')).toEqual({
      displayName: '平台共享技能',
      summary: '平台提供的默认中文说明',
      locale: 'zh-CN',
      source: 'platform_default',
    });
    response = await rig.request(
      '/api/skills/tenants/wain/pool/shared_skill/presentation',
      json('PUT', {
        displayName: '唯恩业务助手',
        summary: '仅在唯恩组织内显示的说明',
        expectedRevision: 0,
      }),
    );
    expect(response.status).toBe(200);
    expect(await presentation(rig, '/api/skills/tenants/wain/pool')).toMatchObject({
      displayName: '唯恩业务助手',
      source: 'organization_override',
      revision: 1,
    });

    const stale = await rig.request(
      '/api/skills/tenants/wain/pool/shared_skill/presentation',
      json('PUT', {
        displayName: '覆盖旧值',
        summary: '不应写入',
        expectedRevision: 0,
      }),
    );
    expect(stale.status).toBe(409);

    rig.setCaller(KAIYAN_USER);
    expect(await presentation(rig, '/api/skills/me')).toMatchObject({
      displayName: '平台共享技能',
      source: 'platform_default',
    });
    rig.setCaller(WAIN_USER);
    expect(await presentation(rig, '/api/skills/me')).toMatchObject({
      displayName: '唯恩业务助手',
      source: 'organization_override',
    });

    rig.setCaller(WAIN_ADMIN);
    response = await rig.request(
      '/api/skills/tenants/wain/pool/shared_skill/presentation?expectedRevision=1',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(200);
    expect(await presentation(rig, '/api/skills/tenants/wain/pool')).toMatchObject({
      displayName: '平台共享技能',
      source: 'platform_default',
    });
    expect(
      rig.governanceAuditStore.events.some(
        (event) =>
          event.action === 'skill.presentation.restore_default' && event.result === 'succeeded',
      ),
    ).toBe(true);
  });

  it('组织管理员不能跨组织修改，且可以维护组织自有技能展示信息', async () => {
    rig.setCaller(WAIN_ADMIN);
    const denied = await rig.request(
      '/api/skills/tenants/kaiyan/pool/shared_skill/presentation',
      json('PUT', {
        displayName: '越权名称',
        summary: '不应写入',
        expectedRevision: 0,
      }),
    );
    expect(denied.status).toBe(403);

    const form = new FormData();
    form.append(
      'files',
      new File(
        ['---\nname: tenant-friendly\ndescription: original description\n---\n# Test'],
        'SKILL.md',
        { type: 'text/markdown' },
      ),
    );
    const uploaded = await rig.request('/api/skills/tenants/wain/import', {
      method: 'POST',
      body: form,
    });
    expect(uploaded.status).toBe(200);

    const updated = await rig.request(
      '/api/skills/tenants/wain/skills/tenant-friendly/presentation',
      json('PUT', {
        displayName: '组织报表助手',
        summary: '生成唯恩内部使用的业务报表',
        expectedRevision: 0,
      }),
    );
    expect(updated.status).toBe(200);
    expect(
      await presentation(rig, '/api/skills/tenants/wain/skills', 'tenant-friendly'),
    ).toMatchObject({
      displayName: '组织报表助手',
      source: 'organization_default',
      revision: 1,
    });
  });

  it('治理审计不可用时拒绝修改并保持原值', async () => {
    rig.setCaller(PLATFORM_ADMIN);
    rig.governanceAuditStore.append = async () => {
      throw new Error('audit offline');
    };
    const response = await rig.request(
      '/api/skills/pool/shared_skill/presentation',
      json('PUT', {
        displayName: '不应写入',
        summary: '审计不可用时不得变更',
        expectedRevision: 0,
      }),
    );
    expect(response.status).toBe(503);
    expect(
      await rig.skillPresentationStore.getExact({
        resourceScope: 'platform',
        resourceTenantId: '',
        skillId: 'shared_skill',
        audienceTenantId: '',
        locale: 'zh-CN',
      }),
    ).toBeNull();
  });

  it('旧版 Skill 写入口封闭后仍允许治理原生展示信息写入', async () => {
    await rig.close();
    rig = await makeTestRig({
      legacyWriteGate: {
        assertLegacyWriteAllowed: async () => {
          throw new Error('sealed');
        },
      },
    });
    rig.setCaller(PLATFORM_ADMIN);
    const response = await rig.request(
      '/api/skills/pool/shared_skill/presentation',
      json('PUT', {
        displayName: '中文名称',
        summary: '治理原生数据不应被旧入口门禁阻断',
        expectedRevision: 0,
      }),
    );
    expect(response.status).toBe(200);
  });

  it('组织管理员不能为平台未向本组织开放的技能预埋展示覆盖', async () => {
    await rig.skillConfigStore.setPlatformSkillConfigs({
      shared_skill: { enabled: true, exposure: 'deny_tenants', tenantIds: ['wain'] },
    });
    rig.setCaller(WAIN_ADMIN);
    const response = await rig.request(
      '/api/skills/tenants/wain/pool/shared_skill/presentation',
      json('PUT', {
        displayName: '不可见技能',
        summary: '不应写入隐藏技能的展示覆盖',
        expectedRevision: 0,
      }),
    );
    expect(response.status).toBe(404);
  });
});
