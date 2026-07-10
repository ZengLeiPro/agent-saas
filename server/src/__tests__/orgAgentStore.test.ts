/**
 * OrgAgentStore 单元测试（公司级专职 Agent；2026-07 唯恩批次）
 *
 * 覆盖：
 *   - audience 三态匹配（all / allow_users 命中与未命中 / deny_users）
 *   - persist → reload 往返（tmpfile+rename 原子持久化后新实例可读回）
 */

import { mkdtemp, rm } from 'node:fs/promises';
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
    // 裁剪视图：只有 id/name/avatar，不泄漏 instructions/guardrail/audience
    expect(list[0]).toEqual({ id: visible.id, name: '产品选型助手', avatar: '🔌' });
  });
});
