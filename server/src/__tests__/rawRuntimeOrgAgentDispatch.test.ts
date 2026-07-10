/**
 * dispatch 链路的专职 Agent 覆盖测试（2026-07 唯恩批次）
 *
 * 覆盖（计划测试 13-14）：
 *   - org 会话：instructions 含组织专职段、无 PERSONA/记忆注入、agentName=org 名、
 *     skill = 可用清单 ∩ allowedSkills 且与 browser filter AND 组合（不是替换）
 *   - orgAgentId 指向 disabled/缺失/跨租户 → fail-closed（dispatch yield error，
 *     绝不静默回退个人 persona + 全量 skill）
 *   - orgAgentId 缺省 → resolveOrgAgentOverrides 返回 null，个人路径零行为变化
 *     （兼容性红线回归）
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInstructions,
  buildOrgAgentSkillFilter,
  buildRuntimeSkillFilter,
  composeSkillFilters,
  createRawRuntimeRunDispatch,
  resolveOrgAgentOverrides,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { HandRecord } from '../runtime/handStore.js';
import type { ChannelContext, OutboundEvent } from '../types/index.js';

// 指向真实 workspace-shared/prompts/（与 runtimeStage2.test.ts 同款），
// 顺带验证 dynamic-personal.md 的 {{#IF_ORG_AGENT}} 模板块真实生效。
const SHARED_DIR = resolve(process.cwd(), '../workspace-shared');

function orgAgentRecord(overrides: Partial<OrgAgentRecord> = {}): OrgAgentRecord {
  return {
    id: 'oa-test-1',
    tenantId: 'wain',
    name: '产品选型助手',
    instructions: '只回答唯恩重载连接器选型问题。',
    allowedSkills: ['wain-kb'],
    audience: { exposure: 'all', usernames: [] },
    guardrail: { enabled: true, scopeDescription: '选型', rejectionMessage: '超纲了。', strictness: 'strict' },
    enabled: true,
    createdAt: '2026-07-10T00:00:00Z',
    createdBy: 'wain_admin',
    updatedAt: '2026-07-10T00:00:00Z',
    updatedBy: 'wain_admin',
    ...overrides,
  };
}

function fakeOrgAgentStore(records: OrgAgentRecord[]): OrgAgentStore {
  return {
    get: (id: string) => records.find((r) => r.id === id),
  } as unknown as OrgAgentStore;
}

describe('resolveOrgAgentOverrides 三态', () => {
  it('orgAgentId 缺省 → null（个人路径零行为变化，兼容红线）', () => {
    expect(resolveOrgAgentOverrides({ orgAgentStore: fakeOrgAgentStore([orgAgentRecord()]) }, undefined, 'wain')).toBeNull();
    // store 未配置时缺省 orgAgentId 同样 null（存量部署完全不受影响）
    expect(resolveOrgAgentOverrides({}, undefined, 'wain')).toBeNull();
  });

  it('record 缺失 / disabled / 租户不符 / store 未配置 → fail-closed error', () => {
    const store = fakeOrgAgentStore([
      orgAgentRecord(),
      orgAgentRecord({ id: 'oa-disabled', enabled: false }),
    ]);
    for (const [config, orgAgentId, tenantId] of [
      [{ orgAgentStore: store }, 'oa-missing', 'wain'],
      [{ orgAgentStore: store }, 'oa-disabled', 'wain'],
      [{ orgAgentStore: store }, 'oa-test-1', 'kaiyan'],   // 跨租户
      [{ orgAgentStore: store }, 'oa-test-1', undefined],  // 租户身份缺失
      [{}, 'oa-test-1', 'wain'],                           // store 未装配
    ] as const) {
      const result = resolveOrgAgentOverrides(config, orgAgentId, tenantId);
      expect(result).not.toBeNull();
      expect(result && 'error' in result).toBe(true);
    }
  });

  it('正常命中 → { agent }', () => {
    const result = resolveOrgAgentOverrides(
      { orgAgentStore: fakeOrgAgentStore([orgAgentRecord()]) }, 'oa-test-1', 'wain',
    );
    expect(result && 'agent' in result && result.agent.name).toBe('产品选型助手');
  });
});

describe('skill 白名单与 browser filter AND 组合', () => {
  const browserSkill = { id: 'browser', name: 'browser', description: 'Browser automation' };
  const kbSkill = { id: 'wain-kb', name: 'wain-kb', description: '唯恩产品知识库' };
  const docSkill = { id: 'docx', name: 'docx', description: 'Word documents' };

  // ACS hand 无 browser capability → base filter 会滤掉 browser skill
  const acsHandWithoutBrowser: HandRecord = {
    handId: 'session:acs',
    sessionId: 'session',
    workspaceId: 'workspace',
    type: 'server-remote',
    status: 'ready',
    endpoint: 'http://10.0.1.1:3400',
    capabilities: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { tenantRemoteHandId: 'agent-saas-acs' },
  };

  it('组合后 = 可用清单 ∩ allowedSkills，且 browser filter 仍生效（AND 不是替换）', () => {
    const base = buildRuntimeSkillFilter([acsHandWithoutBrowser]);
    // 故意把 browser 放进白名单：若 allowlist 是"替换"而非 AND，browser 会漏进来
    const composed = composeSkillFilters(base, buildOrgAgentSkillFilter(orgAgentRecord({
      allowedSkills: ['wain-kb', 'browser'],
    })));

    expect(composed(kbSkill)).toBe(true);     // 白名单内 + base 放行
    expect(composed(docSkill)).toBe(false);   // base 放行但不在白名单
    expect(composed(browserSkill)).toBe(false); // 白名单内但 base（无 browser hand）拒绝
  });

  it('白名单按 id 或 name 命中', () => {
    const filter = buildOrgAgentSkillFilter(orgAgentRecord({ allowedSkills: ['wain-kb'] }));
    expect(filter({ id: 'wain-kb', name: '唯恩知识库', description: '' })).toBe(true);
    expect(filter({ id: 'skill-123', name: 'wain-kb', description: '' })).toBe(true);
    expect(filter({ id: 'docx', name: 'docx', description: '' })).toBe(false);
  });
});

describe('buildInstructions 专职 Agent 覆盖（真实模板渲染）', () => {
  const baseParams = {
    sharedDir: SHARED_DIR,
    agentName: '开开',
    userName: '张三',
    persona: '我是一只爱讲冷笑话的柴犬',
    cwd: '/tmp/ws',
    executionTarget: 'server-local' as const,
    memorySearchEnabled: false,
    isPlatformAdmin: false,
  };

  it('org 会话：含组织专职段 + org 名 + 限定提示语，无个人 PERSONA', () => {
    const instructions = buildInstructions({
      ...baseParams,
      orgAgent: { name: '产品选型助手', instructions: '只回答唯恩重载连接器选型问题。' },
    });
    expect(instructions).toContain('组织专职身份');
    expect(instructions).toContain('产品选型助手');
    expect(instructions).toContain('只回答唯恩重载连接器选型问题。');
    // IF_PERSONA / IF_NO_PERSONA 均 false：个人 persona 不注入
    expect(instructions).not.toContain('爱讲冷笑话的柴犬');
    expect(instructions).not.toContain('开开');
    // 模板变量必须全部渲染干净
    expect(instructions).not.toContain('{{');
  });

  it('个人会话（缺省）：persona 正常注入、无组织专职段（兼容红线）', () => {
    const instructions = buildInstructions(baseParams);
    expect(instructions).toContain('爱讲冷笑话的柴犬');
    expect(instructions).toContain('开开');
    expect(instructions).not.toContain('组织专职身份');
    expect(instructions).not.toContain('{{');
  });
});

describe('dispatch fail-closed 集成（yield error，不静默回退）', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function runDispatch(orgAgentId: string, store?: OrgAgentStore): Promise<OutboundEvent[]> {
    const tmp = await mkdtemp(join(tmpdir(), 'org-dispatch-'));
    dirs.push(tmp);
    const dispatch = createRawRuntimeRunDispatch({
      agentCwd: tmp,
      sharedDir: SHARED_DIR,
      ...(store ? { orgAgentStore: store } : {}),
    });
    const context: ChannelContext = {
      channel: 'web',
      user: { id: 'u-1', username: 'alice', role: 'user', tenantId: 'wain' },
    };
    const events: OutboundEvent[] = [];
    for await (const event of dispatch(
      { channel: 'web', chatId: 'chat-1', content: '你好' },
      context,
      { orgAgentId, modelConnection: { apiKey: 'test-key' } },
    )) {
      events.push(event);
      if (event.type === 'error') break;
    }
    return events;
  }

  it('orgAgentId 指向 disabled 记录 → 首个事件即 error，run 不启动', async () => {
    const events = await runDispatch('oa-disabled', fakeOrgAgentStore([
      orgAgentRecord({ id: 'oa-disabled', enabled: false }),
    ]));
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { error?: string }).error).toContain('停用');
  });

  it('orgAgentId 指向缺失记录 / store 未装配 → 同样 fail-closed error', async () => {
    const missing = await runDispatch('oa-nope', fakeOrgAgentStore([orgAgentRecord()]));
    expect(missing[0]?.type).toBe('error');

    const noStore = await runDispatch('oa-test-1', undefined);
    expect(noStore[0]?.type).toBe('error');
    expect((noStore[0] as { error?: string }).error).toContain('不可用');
  });
});
