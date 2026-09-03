import { describe, expect, it } from 'vitest';
import {
  resolveLegacyPersonalTarget,
  resolveSessionAgentTargetForAccess,
  type SessionMeta,
} from '../data/transcripts/meta.js';

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    userId: 'u1',
    username: 'alice',
    channel: 'web',
    createdAt: '2026-08-01T00:00:00.000Z',
    tenantId: 'kaiyan',
    ...overrides,
  };
}

describe('legacy personal target 判定', () => {
  it('无 agentTarget 且无 orgAgentId 且 tenant 一致时判为 personal', () => {
    expect(resolveLegacyPersonalTarget(meta(), 'kaiyan')).toEqual({
      kind: 'personal',
      tenantId: 'kaiyan',
    });
  });

  it('meta 缺 tenantId 时用 expectedTenantId 兜底', () => {
    expect(resolveLegacyPersonalTarget(meta({ tenantId: undefined }), 'kaiyan')).toEqual({
      kind: 'personal',
      tenantId: 'kaiyan',
    });
  });

  it('带 orgAgentId 的历史会话绝不降级为 personal', () => {
    expect(resolveLegacyPersonalTarget(meta({ orgAgentId: 'oa-1' }), 'kaiyan')).toBeNull();
  });

  it('已有 canonical agentTarget 时不走 legacy 分支', () => {
    const withTarget = meta({ agentTarget: { kind: 'personal', tenantId: 'kaiyan' } });
    expect(resolveLegacyPersonalTarget(withTarget, 'kaiyan')).toBeNull();
  });

  it('跨租户请求不得升级', () => {
    expect(resolveLegacyPersonalTarget(meta(), 'other-tenant')).toBeNull();
  });

  it('无法证明租户时保持不可升级', () => {
    expect(resolveLegacyPersonalTarget(meta({ tenantId: undefined }), undefined)).toBeNull();
    expect(resolveLegacyPersonalTarget(null, 'kaiyan')).toBeNull();
  });
});

describe('resolveSessionAgentTargetForAccess', () => {
  it('N-1 个人会话解析为 bound + needsMigration，走既有迁移路径落盘', () => {
    expect(resolveSessionAgentTargetForAccess(meta(), 'kaiyan')).toEqual({
      status: 'bound',
      target: { kind: 'personal', tenantId: 'kaiyan' },
      needsMigration: true,
    });
  });

  it('canonical target 原样透传，不被 legacy 分支改写', () => {
    const orgTarget = { kind: 'org-agent' as const, tenantId: 'kaiyan', orgAgentId: 'oa-1' };
    const resolved = resolveSessionAgentTargetForAccess(
      meta({ agentTarget: orgTarget, orgAgentId: 'oa-1', agentTargetBindingVersion: 1 }),
      'kaiyan',
    );
    expect(resolved.status).toBe('bound');
    expect(resolved.status === 'bound' && resolved.target).toEqual(orgTarget);
  });

  it('带 orgAgentId 但缺 agentTarget 时仍解析为 org-agent 而非 personal', () => {
    const resolved = resolveSessionAgentTargetForAccess(meta({ orgAgentId: 'oa-1' }), 'kaiyan');
    expect(resolved.status === 'bound' && resolved.target).toEqual({
      kind: 'org-agent',
      tenantId: 'kaiyan',
      orgAgentId: 'oa-1',
    });
  });

  it('跨租户仍为 unproven', () => {
    expect(resolveSessionAgentTargetForAccess(meta(), 'other-tenant')).toEqual({
      status: 'unproven',
    });
  });
});
