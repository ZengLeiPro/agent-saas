/**
 * OrgAgentStore 单元测试（公司级专职 Agent；2026-07 唯恩批次）
 *
 * 覆盖：
 *   - audience 三态匹配（all / allow_users 命中与未命中 / deny_users）
 *   - persist → reload 往返（tmpfile+rename 原子持久化后新实例可读回）
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OrgAgentStore, isAssignedToOrgAgent } from '../data/orgAgents/store.js';
import type { OrgAgentGuardrailConfig } from '../data/orgAgents/types.js';

const GUARDRAIL: OrgAgentGuardrailConfig = {
  enabled: true,
  scopeDescription: '唯恩电气产品选型与技术问答',
  rejectionMessage: '这个问题超出了我的职责范围。',
  strictness: 'strict',
};

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'wain',
    name: '产品选型助手',
    avatar: '🔌',
    description: '帮助成员完成产品选型与参数查询。',
    starterPrompts: ['帮我推荐一个型号'],
    instructions: '你负责唯恩产品选型问答。',
    allowedSkills: ['wain-kb'],
    audience: { exposure: 'all' as const, usernames: [] },
    guardrail: GUARDRAIL,
    enabled: true,
    ...overrides,
  };
}

describe('isAssignedToOrgAgent（audience 三态匹配）', () => {
  it('exposure=all：任意用户（含匿名）都命中', () => {
    const record = { audience: { exposure: 'all' as const, usernames: [] } };
    expect(isAssignedToOrgAgent(record, 'alice')).toBe(true);
    expect(isAssignedToOrgAgent(record, undefined)).toBe(true);
  });

  it('exposure=allow_users：名单内命中、名单外与匿名不命中', () => {
    const record = { audience: { exposure: 'allow_users' as const, usernames: ['alice', 'bob'] } };
    expect(isAssignedToOrgAgent(record, 'alice')).toBe(true);
    expect(isAssignedToOrgAgent(record, 'carol')).toBe(false);
    expect(isAssignedToOrgAgent(record, undefined)).toBe(false);
  });

  it('exposure=deny_users：名单内不命中、名单外命中、匿名不命中', () => {
    const record = { audience: { exposure: 'deny_users' as const, usernames: ['mallory'] } };
    expect(isAssignedToOrgAgent(record, 'mallory')).toBe(false);
    expect(isAssignedToOrgAgent(record, 'alice')).toBe(true);
    // 匿名身份无法证明不在 deny 名单里，fail-safe 不命中
    expect(isAssignedToOrgAgent(record, undefined)).toBe(false);
  });
});

describe('OrgAgentStore persist-reload 往返', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function tmpStorePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'org-agent-store-'));
    dirs.push(dir);
    return join(dir, 'org-agents.json');
  }

  it('create → 新实例 reload 读回完整字段', async () => {
    const filePath = await tmpStorePath();
    const store = new OrgAgentStore(filePath);
    const created = await store.create(createInput(), 'wain_admin');

    expect(created.id).toMatch(/^oa-/);
    expect(created.createdBy).toBe('wain_admin');
    expect(created.updatedBy).toBe('wain_admin');

    const reloaded = new OrgAgentStore(filePath);
    const record = reloaded.get(created.id);
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      id: created.id,
      tenantId: 'wain',
      name: '产品选型助手',
      avatar: '🔌',
      description: '帮助成员完成产品选型与参数查询。',
      starterPrompts: ['帮我推荐一个型号'],
      instructions: '你负责唯恩产品选型问答。',
      allowedSkills: ['wain-kb'],
      audience: { exposure: 'all', usernames: [] },
      guardrail: GUARDRAIL,
      enabled: true,
    });
  });

  it('update / remove 均持久化到磁盘', async () => {
    const filePath = await tmpStorePath();
    const store = new OrgAgentStore(filePath);
    const a = await store.create(createInput({ name: '选型助手' }), 'wain_admin');
    const b = await store.create(createInput({ name: '售后助手' }), 'wain_admin');

    await store.update(a.id, { enabled: false, name: '选型助手 v2' }, 'wain_admin2');
    await store.remove(b.id);

    const reloaded = new OrgAgentStore(filePath);
    expect(reloaded.get(b.id)).toBeUndefined();
    const updated = reloaded.get(a.id);
    expect(updated?.name).toBe('选型助手 v2');
    expect(updated?.enabled).toBe(false);
    expect(updated?.updatedBy).toBe('wain_admin2');
    // create 元数据不被 update 覆盖
    expect(updated?.createdBy).toBe('wain_admin');
  });

  it('并发 create 两条记录都持久化到磁盘（F6 写队列串行化）', async () => {
    const filePath = await tmpStorePath();
    const store = new OrgAgentStore(filePath);

    // 不 await 单个 create，模拟并发写；写队列应串行化「内存变更+persist」
    const [a, b] = await Promise.all([
      store.create(createInput({ name: '并发助手 A' }), 'wain_admin'),
      store.create(createInput({ name: '并发助手 B' }), 'wain_admin'),
    ]);

    const reloaded = new OrgAgentStore(filePath);
    expect(reloaded.get(a.id)?.name).toBe('并发助手 A');
    expect(reloaded.get(b.id)?.name).toBe('并发助手 B');
    expect(reloaded.listByTenant('wain')).toHaveLength(2);
  });

  it('listForUser 只返回本租户 enabled + 被指派的裁剪视图', async () => {
    const filePath = await tmpStorePath();
    const store = new OrgAgentStore(filePath);
    const visible = await store.create(createInput({
      audience: { exposure: 'allow_users' as const, usernames: ['alice'] },
    }), 'wain_admin');
    await store.create(createInput({ name: '停用的', enabled: false }), 'wain_admin');
    await store.create(createInput({ name: '别家租户的', tenantId: 'kaiyan' }), 'kaiyan_admin');
    await store.create(createInput({
      name: '未指派的',
      audience: { exposure: 'allow_users' as const, usernames: ['bob'] },
    }), 'wain_admin');

    const list = store.listForUser('wain', 'alice');
    expect(list).toHaveLength(1);
    // 裁剪视图：只含安全公开资料，不泄漏 instructions/guardrail/audience/Skill id
    expect(list[0]).toEqual({
      id: visible.id,
      name: '产品选型助手',
      avatar: '🔌',
      description: '帮助成员完成产品选型与参数查询。',
      starterPrompts: ['帮我推荐一个型号'],
      skillCount: 1,
    });
  });

  it('旧版记录缺公开字段时加载为空值，保持生产文件兼容', async () => {
    const filePath = await tmpStorePath();
    await writeFile(filePath, JSON.stringify({
      version: 1,
      agents: [{
        id: 'oa-legacy', tenantId: 'wain', name: '旧专家', instructions: '', allowedSkills: [],
        audience: { exposure: 'all', usernames: [] },
        guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '超范围', strictness: 'strict' },
        enabled: true, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
      }],
    }));
    const store = new OrgAgentStore(filePath);
    const record = store.get('oa-legacy');
    expect(record).toMatchObject({ description: '', starterPrompts: [] });
    // 新增 optional 字段：旧记录读入后 undefined（未设置）
    expect(record?.allowedKnowledge).toBeUndefined();
    expect(record?.audience.departmentIds).toBeUndefined();
    expect(record?.audience.roles).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────────
  // 2026-07-18 企业专家目录 MVP：3 个 optional 字段扩展（蓝图 v2 § 4.1.1）
  // ────────────────────────────────────────────────────────────────────
  it('allowedKnowledge / audience.departmentIds / audience.roles：create 落库 + reload 保真', async () => {
    const filePath = await tmpStorePath();
    const store = new OrgAgentStore(filePath);
    const created = await store.create(
      createInput({
        allowedKnowledge: ['kb-quote-rules', 'kb-customer-history'],
        audience: {
          exposure: 'allow_users' as const,
          usernames: ['alice'],
          departmentIds: ['dept-sales', 'dept-finance'],
          roles: ['sales-lead', 'ops'],
        },
      }),
      'wain_admin',
    );
    expect(created.allowedKnowledge).toEqual(['kb-quote-rules', 'kb-customer-history']);
    expect(created.audience.departmentIds).toEqual(['dept-sales', 'dept-finance']);
    expect(created.audience.roles).toEqual(['sales-lead', 'ops']);

    const reloaded = new OrgAgentStore(filePath);
    const roundTripped = reloaded.get(created.id);
    expect(roundTripped?.allowedKnowledge).toEqual(['kb-quote-rules', 'kb-customer-history']);
    expect(roundTripped?.audience.departmentIds).toEqual(['dept-sales', 'dept-finance']);
    expect(roundTripped?.audience.roles).toEqual(['sales-lead', 'ops']);
  });

  it('update：allowedKnowledge 传空数组 → 字段被清空（"未设置"语义）', async () => {
    const filePath = await tmpStorePath();
    const store = new OrgAgentStore(filePath);
    const created = await store.create(
      createInput({ allowedKnowledge: ['kb-a'] }),
      'wain_admin',
    );
    expect(created.allowedKnowledge).toEqual(['kb-a']);
    const updated = await store.update(created.id, { allowedKnowledge: [] }, 'wain_admin');
    expect(updated?.allowedKnowledge).toBeUndefined();
  });

  it('create 不传新字段时向后兼容：字段全部 undefined（不写入磁盘噪声）', async () => {
    const filePath = await tmpStorePath();
    const store = new OrgAgentStore(filePath);
    const created = await store.create(createInput(), 'wain_admin');
    expect(created.allowedKnowledge).toBeUndefined();
    expect(created.audience.departmentIds).toBeUndefined();
    expect(created.audience.roles).toBeUndefined();
  });
});
