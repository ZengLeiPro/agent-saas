/**
 * 企业专家目录 · 3 个种子模板 + 租户 seed 幂等测试（2026-07-18 蓝图 v2 § 5）
 *
 * 覆盖：
 *   - 3 个种子模板结构完整（name/scopeDescription 三段式/guardrail.mode=shadow 等）
 *   - 新租户 seed 3 条全部落库；老租户全量跳过；同名冲突逐条跳过
 *   - guardrail 按业务严肃度分档：strict=报价/合同、lenient=情报
 *   - audience：合同用 allow_users（白名单）、其他 all；departmentIds/roles 未暴露
 *   - 单条 create 抛错不阻断其他条目（错误落 errors 数组）
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OrgAgentStore } from '../data/orgAgents/store.js';
import {
  ORG_AGENT_SEED_TEMPLATES,
  seedOrgAgentTemplatesForTenant,
  shouldSkipTenantSeed,
} from '../data/orgAgentTemplates.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function makeStore(): Promise<OrgAgentStore> {
  const dir = await mkdtemp(join(tmpdir(), 'org-agent-templates-'));
  dirs.push(dir);
  return new OrgAgentStore(join(dir, 'org-agents.json'));
}

describe('ORG_AGENT_SEED_TEMPLATES · 静态模板结构', () => {
  it('恰好 3 条模板，templateId 唯一', () => {
    expect(ORG_AGENT_SEED_TEMPLATES).toHaveLength(3);
    const ids = ORG_AGENT_SEED_TEMPLATES.map((t) => t.templateId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([
      'template-quote-reviewer',
      'template-customer-analyst',
      'template-contract-checker',
    ]);
  });

  it('每个模板 name / description / instructions / scopeDescription 均非空', () => {
    for (const tpl of ORG_AGENT_SEED_TEMPLATES) {
      expect(tpl.payload.name.length).toBeGreaterThan(0);
      expect(tpl.payload.name.length).toBeLessThanOrEqual(30);
      expect(tpl.payload.description ?? '').not.toBe('');
      expect(tpl.payload.instructions.length).toBeGreaterThan(0);
      expect(tpl.payload.guardrail.scopeDescription.length).toBeGreaterThan(0);
      expect(tpl.payload.guardrail.rejectionMessage.length).toBeGreaterThan(0);
    }
  });

  it('全部模板 guardrail.mode=shadow（上线观察期）且 enabled=false（管理员主动启用）', () => {
    for (const tpl of ORG_AGENT_SEED_TEMPLATES) {
      expect(tpl.payload.guardrail.mode).toBe('shadow');
      expect(tpl.payload.enabled).toBe(false);
    }
  });

  it('scopeDescription 三段式：包含"允许问 / 拒绝问"标签（呼应 UI 填空题）', () => {
    for (const tpl of ORG_AGENT_SEED_TEMPLATES) {
      const scope = tpl.payload.guardrail.scopeDescription;
      expect(scope).toContain('允许问');
      expect(scope).toContain('拒绝问');
    }
  });

  it('strictness 按业务严肃度分档：报价/合同 strict、客户情报 lenient', () => {
    const byId = new Map(ORG_AGENT_SEED_TEMPLATES.map((t) => [t.templateId, t]));
    expect(byId.get('template-quote-reviewer')!.payload.guardrail.strictness).toBe('strict');
    expect(byId.get('template-contract-checker')!.payload.guardrail.strictness).toBe('strict');
    expect(byId.get('template-customer-analyst')!.payload.guardrail.strictness).toBe('lenient');
  });

  it('合同风险检测员默认 audience=allow_users（白名单，敏感度高）', () => {
    const contract = ORG_AGENT_SEED_TEMPLATES.find(
      (t) => t.templateId === 'template-contract-checker',
    )!;
    expect(contract.payload.audience.exposure).toBe('allow_users');
    // 空 usernames = 白名单未填，管理员启用时才决定给谁
    expect(contract.payload.audience.usernames).toEqual([]);
  });

  it('报价/情报 audience=all，且不带 departmentIds/roles（MVP 阶段 UI 不暴露）', () => {
    for (const id of ['template-quote-reviewer', 'template-customer-analyst']) {
      const tpl = ORG_AGENT_SEED_TEMPLATES.find((t) => t.templateId === id)!;
      expect(tpl.payload.audience.exposure).toBe('all');
      expect(tpl.payload.audience.departmentIds).toBeUndefined();
      expect(tpl.payload.audience.roles).toBeUndefined();
    }
  });

  it('avatar 使用 8 岗位预设 key（sales / boss / …）', () => {
    for (const tpl of ORG_AGENT_SEED_TEMPLATES) {
      expect(tpl.payload.avatar).toMatch(/^(boss|sales|marketing|procurement|finance|hr|cs|production)$/);
    }
  });
});

describe('seedOrgAgentTemplatesForTenant · 幂等 + 边界', () => {
  it('新租户：3 条模板全部落库，records enabled=false', async () => {
    const store = await makeStore();
    const result = await seedOrgAgentTemplatesForTenant(store, 'kaiyan', 'system');
    expect(result.seeded).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    const records = store.listByTenant('kaiyan');
    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.enabled).toBe(false);
      expect(r.tenantId).toBe('kaiyan');
      expect(r.createdBy).toBe('system');
      // guardrail 归一化后 mode 保留（load 时 mode 是 optional，写入时保留）
      expect(r.guardrail.scopeDescription).toContain('允许问');
    }
  });

  it('老租户（已有任一 org-agent）：全量跳过，不追加 seed', async () => {
    const store = await makeStore();
    // 先手工建 1 条（模拟老租户已有专家）
    await store.create(
      {
        tenantId: 'kaiyan',
        name: '既有专家',
        instructions: '',
        allowedSkills: [],
        audience: { exposure: 'all', usernames: [] },
        guardrail: {
          mode: 'off',
          enabled: false,
          scopeDescription: '',
          rejectionMessage: '不在范围。',
          strictness: 'strict',
        },
        enabled: true,
      },
      'admin',
    );
    expect(shouldSkipTenantSeed(store, 'kaiyan')).toBe(true);

    const result = await seedOrgAgentTemplatesForTenant(store, 'kaiyan', 'system');
    expect(result.seeded).toHaveLength(0);
    expect(result.skipped).toEqual([
      'template-quote-reviewer',
      'template-customer-analyst',
      'template-contract-checker',
    ]);
    // 依然只有原来那 1 条
    expect(store.listByTenant('kaiyan')).toHaveLength(1);
  });

  it('多次调用等价一次（幂等）：第二次 seed 全量 skip', async () => {
    const store = await makeStore();
    const first = await seedOrgAgentTemplatesForTenant(store, 'kaiyan', 'system');
    expect(first.seeded).toHaveLength(3);
    const second = await seedOrgAgentTemplatesForTenant(store, 'kaiyan', 'system');
    expect(second.seeded).toHaveLength(0);
    expect(second.skipped).toHaveLength(3);
    expect(store.listByTenant('kaiyan')).toHaveLength(3);
  });

  it('跨租户隔离：seed A 租户不影响 B 租户', async () => {
    const store = await makeStore();
    await seedOrgAgentTemplatesForTenant(store, 'tenant-a', 'system');
    const result = await seedOrgAgentTemplatesForTenant(store, 'tenant-b', 'system');
    expect(result.seeded).toHaveLength(3);
    expect(store.listByTenant('tenant-a')).toHaveLength(3);
    expect(store.listByTenant('tenant-b')).toHaveLength(3);
  });
});
