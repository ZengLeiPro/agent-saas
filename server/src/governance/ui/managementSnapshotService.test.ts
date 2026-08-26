import { describe, expect, it, vi } from 'vitest';

import { MANAGEMENT_ACTIONS_V1 } from '../../../../shared/src/types/governance.js';
import type { GovernanceAuditAppendInput } from '../../data/governance-audit/types.js';
import {
  ACTION_CATALOG,
  getActionDefinition,
  getManagementActionDefinition,
} from '../access/actionCatalog.js';
import { PersonaPolicy } from '../access/policies/personaPolicy.js';
import type { HumanSubjectContext } from '../subject/types.js';
import {
  ManagementSnapshotError,
  ManagementSnapshotService,
  type ManagementSnapshotDeps,
} from './managementSnapshotService.js';

const now = '2026-08-25T18:00:00.000Z';
const user = (id: string, tenantId: string, disabled = false) => ({
  id, tenantId, username: id, role: 'user' as const, passwordHash: 'x', disabled,
  createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system',
});
const membership = (
  userId: string,
  persona: 'member' | 'org_admin',
  isOwner = false,
  status: 'active' | 'disabled' = 'active',
  version = 7,
) => ({
  tenantId: 'tenant-a', userId, persona, isOwner, status, source: 'governance' as const, version,
  createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system',
});
const platformAdmin = { userId: 'platform-1', status: 'active' as const, source: 'governance' as const, version: 11,
  createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system' };

type Actor = 'member-1' | 'owner-1' | 'platform-1' | 'inactive-1';
function rig(input: {
  actor?: Actor;
  membershipFailure?: boolean;
  strictTenantFailureFor?: string;
  missingTenants?: string[];
  disabledTenants?: string[];
  auditFailure?: boolean;
  changeVersionAfterIntent?: boolean;
} = {}) {
  const actor = input.actor ?? 'member-1';
  const users = new Map([
    ['member-1', user('member-1', 'tenant-a')],
    ['owner-1', user('owner-1', 'tenant-a')],
    ['inactive-1', user('inactive-1', 'tenant-a')],
    ['platform-1', user('platform-1', 'pantheon')],
  ]);
  const memberships = new Map([
    ['member-1', membership('member-1', 'member')],
    ['owner-1', membership('owner-1', 'org_admin', true)],
    ['inactive-1', membership('inactive-1', 'member', false, 'disabled')],
  ]);
  const auditAppend = input.auditFailure
    ? vi.fn().mockRejectedValue(new Error('audit down'))
    : vi.fn(async (value: GovernanceAuditAppendInput) => {
      if (value.result === 'intent' && input.changeVersionAfterIntent) {
        memberships.set(actor, membership(actor, actor === 'owner-1' ? 'org_admin' : 'member', actor === 'owner-1', 'active', 8));
      }
      return { auditId: 'audit-1', ...value };
    });
  const tenantRecord = (id: string) => {
    if (input.missingTenants?.includes(id) || !['tenant-a', 'tenant-b', 'pantheon'].includes(id)) return undefined;
    return {
      id, name: id, createdAt: now, createdBy: 'system', updatedAt: now,
      disabled: input.disabledTenants?.includes(id) ?? false,
    };
  };
  const findById = vi.fn((id: string) => tenantRecord(id));
  const findByIdStrict = vi.fn((id: string) => {
    if (input.strictTenantFailureFor === id) throw new Error('strict tenant authority down');
    return tenantRecord(id);
  });
  const deps = {
    users: { findById: (id: string) => users.get(id) },
    tenants: { findById, findByIdStrict },
    memberships: {
      getMembership: vi.fn(async (_tenantId: string, id: string) => {
        if (input.membershipFailure) throw new Error('membership down');
        return memberships.get(id) ?? null;
      }),
      getPlatformAdmin: vi.fn(async (id: string) => {
        if (input.membershipFailure) throw new Error('membership down');
        return id === 'platform-1' ? platformAdmin : null;
      }),
    },
    audit: { append: auditAppend },
    now: () => new Date(now),
  } as unknown as ManagementSnapshotDeps;
  return { actor, service: new ManagementSnapshotService(deps), auditAppend, findById, findByIdStrict };
}

const request = (tenantId = 'tenant-a') => ({ decisions: [
  { action: 'settings.personal.view' as const, scope: { kind: 'personal' as const } },
  { action: 'settings.tenant.view' as const, scope: { kind: 'tenant' as const, tenantId } },
  { action: 'settings.platform.view' as const, scope: { kind: 'platform' as const } },
] });

describe('ManagementSnapshotService v1', () => {
  it('对三种 Persona 和 Owner 返回窄化 capability + scope 快照', async () => {
    const member = rig();
    const memberResult = await member.service.createSnapshot(member.actor, request());
    expect(memberResult.subject).toEqual({ userId: 'member-1', tenantId: 'tenant-a', persona: 'member', isOwner: false });
    expect(memberResult.decisions.map(item => item.allowed)).toEqual([true, false, false]);
    expect(memberResult.policySnapshot).toEqual({ membershipVersion: 7 });
    expect(member.auditAppend.mock.calls[0]?.[0].metadata).toEqual({
      decisionCount: 3,
      contractVersion: 'v1',
      actions: JSON.stringify(MANAGEMENT_ACTIONS_V1),
      scopeKinds: JSON.stringify(['personal', 'tenant', 'platform']),
      requestedTenantIds: JSON.stringify(['tenant-a']),
      requestedTenantIdCount: 1,
      requestedTenantIdsTruncated: false,
    });
    expect(member.auditAppend.mock.calls[1]?.[0].metadata).toMatchObject({ allowCount: 1, denyCount: 2 });

    const owner = rig({ actor: 'owner-1' });
    const ownerResult = await owner.service.createSnapshot(owner.actor, request());
    expect(ownerResult.subject).toMatchObject({ persona: 'org_admin', isOwner: true });
    expect(ownerResult.decisions.map(item => item.allowed)).toEqual([true, true, false]);
    expect(ownerResult.decisions[1]?.constraints).toEqual(['SAME_TENANT_ONLY']);

    const platform = rig({ actor: 'platform-1' });
    const platformResult = await platform.service.createSnapshot(platform.actor, request('tenant-b'));
    expect(platformResult.subject).toMatchObject({ tenantId: 'pantheon', persona: 'platform_admin', isOwner: false });
    expect(platformResult.decisions.map(item => item.allowed)).toEqual([true, true, true]);
    expect(platformResult.decisions[1]?.constraints).toEqual(['EXPLICIT_TENANT_SCOPE']);
    expect(platformResult.policySnapshot).toEqual({ membershipVersion: 11 });
  });

  it('tenant-view + platform scope 仅允许 platform_admin 进入跨组织管理并要求显式 tenant scope', async () => {
    for (const actor of ['member-1', 'owner-1', 'platform-1'] as const) {
      const current = rig({ actor });
      const result = await current.service.createSnapshot(current.actor, {
        decisions: [{ action: 'settings.tenant.view', scope: { kind: 'platform' } }],
      });
      expect(result.decisions[0]).toMatchObject({
        allowed: actor === 'platform-1',
        reason: actor === 'platform-1'
          ? { code: 'PLATFORM_TENANT_MANAGEMENT_ALLOWED', label: '平台管理员可进入跨组织管理' }
          : { code: 'PLATFORM_ADMIN_REQUIRED', label: '仅平台管理员可进入跨组织管理' },
        constraints: ['EXPLICIT_TENANT_SCOPE'],
      });
    }
  });

  it('actor 所属 tenant 缺失或 disabled 时拒绝，包括 platform_admin 的 actor tenant', async () => {
    for (const setup of [
      { actor: 'member-1' as const, missingTenants: ['tenant-a'], code: 'GOVERNANCE_TENANT_NOT_FOUND' },
      { actor: 'member-1' as const, disabledTenants: ['tenant-a'], code: 'GOVERNANCE_TENANT_INACTIVE' },
      { actor: 'platform-1' as const, disabledTenants: ['pantheon'], code: 'GOVERNANCE_TENANT_INACTIVE' },
    ]) {
      const current = rig(setup);
      await expect(current.service.createSnapshot(current.actor, request())).rejects.toMatchObject({ status: 403, code: setup.code });
      expect(current.auditAppend).not.toHaveBeenCalled();
    }
  });

  it('platform_admin 可访问明确存在但 disabled 的目标 tenant，供恢复用途', async () => {
    const platform = rig({ actor: 'platform-1', disabledTenants: ['tenant-b'] });
    const result = await platform.service.createSnapshot(platform.actor, {
      decisions: [{ action: 'settings.tenant.view', scope: { kind: 'tenant', tenantId: 'tenant-b' } }],
    });
    expect(result.decisions[0]).toMatchObject({
      allowed: true,
      reason: { code: 'PLATFORM_ADMIN_EXPLICIT_TENANT_ALLOWED' },
      constraints: ['EXPLICIT_TENANT_SCOPE'],
    });
  });

  it('intent audit 后身份版本变化会记录 failed 并 fail closed', async () => {
    const changed = rig({ changeVersionAfterIntent: true });
    await expect(changed.service.createSnapshot(changed.actor, request())).rejects.toMatchObject({
      status: 403, code: 'GOVERNANCE_SUBJECT_CHANGED',
    });
    expect(changed.auditAppend.mock.calls.map(call => call[0].result)).toEqual(['intent', 'failed']);
    expect(changed.auditAppend.mock.calls[1]?.[0]).toMatchObject({
      actorPersona: 'member',
      correlationId: changed.auditAppend.mock.calls[0]?.[0].correlationId,
      metadata: { failureCode: 'GOVERNANCE_SUBJECT_CHANGED' },
    });
  });

  it('组织管理员跨租户、平台管理员未知租户及动作/scope 错配均 fail closed', async () => {
    const owner = rig({ actor: 'owner-1' });
    const cross = await owner.service.createSnapshot(owner.actor, {
      decisions: [{ action: 'settings.tenant.view', scope: { kind: 'tenant', tenantId: 'tenant-b' } }],
    });
    expect(cross.decisions[0]).toMatchObject({ allowed: false, reason: { code: 'TENANT_SCOPE_MISMATCH' } });

    const platform = rig({ actor: 'platform-1' });
    const absent = await platform.service.createSnapshot(platform.actor, {
      decisions: [{ action: 'settings.tenant.view', scope: { kind: 'tenant', tenantId: 'missing' } }],
    });
    expect(absent.decisions[0]).toMatchObject({ allowed: false, reason: { code: 'TENANT_NOT_FOUND' } });

    const mismatch = await owner.service.createSnapshot(owner.actor, {
      decisions: [{ action: 'settings.platform.view', scope: { kind: 'personal' } }],
    });
    expect(mismatch.decisions[0]).toMatchObject({
      allowed: false, reason: { code: 'ACTION_SCOPE_MISMATCH' }, constraints: ['PLATFORM_ONLY'],
    });
  });

  it('intent 审计对明确 tenant IDs 去重并安全截断', async () => {
    const current = rig();
    const longTenantId = `tenant-${'x'.repeat(90)}`;
    const tenantIds = [
      longTenantId, 'tenant-0', 'tenant-1', 'tenant-1', 'tenant-2', 'tenant-3', 'tenant-4',
      'tenant-5', 'tenant-7',
    ];
    await current.service.createSnapshot(current.actor, {
      decisions: tenantIds.map(tenantId => ({
        action: 'settings.tenant.view' as const,
        scope: { kind: 'tenant' as const, tenantId },
      })),
    });
    const metadata = current.auditAppend.mock.calls[0]?.[0].metadata;
    expect(JSON.parse(String(metadata?.requestedTenantIds))).toEqual([
      longTenantId.slice(0, 64), 'tenant-0', 'tenant-1', 'tenant-2', 'tenant-3', 'tenant-4',
    ]);
    expect(metadata).toMatchObject({
      requestedTenantIdCount: 8,
      requestedTenantIdsTruncated: true,
      actions: JSON.stringify(['settings.tenant.view']),
      scopeKinds: JSON.stringify(['tenant']),
    });
    expect(String(metadata?.requestedTenantIds).length).toBeLessThanOrEqual(500);
  });

  it('拒绝未知动作、空批次和超过 64 条，且不会审计无效载荷', async () => {
    const { actor, service, auditAppend } = rig();
    for (const invalid of [
      { decisions: [{ action: 'settings.tenant.write', scope: { kind: 'tenant', tenantId: 'tenant-a' } }] },
      { decisions: [] },
      { decisions: Array.from({ length: 65 }, () => ({ action: 'settings.personal.view', scope: { kind: 'personal' } })) },
    ]) {
      await expect(service.createSnapshot(actor, invalid as never)).rejects.toMatchObject({
        status: 400, code: 'INVALID_MANAGEMENT_SNAPSHOT_REQUEST',
      });
    }
    expect(auditAppend).not.toHaveBeenCalled();
  });

  it('inactive membership、权威依赖和审计失败均拒绝且不返回降级快照', async () => {
    const inactive = rig({ actor: 'inactive-1' });
    await expect(inactive.service.createSnapshot(inactive.actor, request())).rejects.toMatchObject({
      status: 403, code: 'GOVERNANCE_MEMBERSHIP_INACTIVE',
    });

    const membershipDown = rig({ membershipFailure: true });
    await expect(membershipDown.service.createSnapshot(membershipDown.actor, request())).rejects.toMatchObject({
      status: 503, code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE',
    });
    expect(membershipDown.auditAppend).not.toHaveBeenCalled();

    const strictDown = rig({ actor: 'platform-1', strictTenantFailureFor: 'tenant-b' });
    await expect(strictDown.service.createSnapshot(strictDown.actor, request('tenant-b'))).rejects.toMatchObject({
      status: 503, code: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE',
    });
    expect(strictDown.findById).not.toHaveBeenCalled();
    expect(strictDown.auditAppend.mock.calls.map(call => call[0].result)).toEqual(['intent', 'failed']);
    expect(strictDown.auditAppend.mock.calls[1]?.[0].metadata).toMatchObject({
      failureCode: 'GOVERNANCE_DEPENDENCY_UNAVAILABLE',
    });

    const auditDown = rig({ auditFailure: true });
    await expect(auditDown.service.createSnapshot(auditDown.actor, request())).rejects.toEqual(
      expect.objectContaining<Partial<ManagementSnapshotError>>({ status: 503, code: 'GOVERNANCE_AUDIT_UNAVAILABLE' }),
    );
  });

  it('shared 动作常量、management accessor 与通用 PersonaPolicy 保持隔离一致', async () => {
    expect([...ACTION_CATALOG.values()].filter(item => item.managementOnly).map(item => item.action)).toEqual(MANAGEMENT_ACTIONS_V1);
    for (const action of MANAGEMENT_ACTIONS_V1) {
      expect(getManagementActionDefinition(action)).toMatchObject({ action, managementOnly: true });
      expect(getActionDefinition(action)).toBeUndefined();
    }
    const subject: HumanSubjectContext = {
      subjectType: 'human', subjectId: 'owner-1', tenantId: 'tenant-a', persona: 'org_admin',
      isOwner: true, accountStatus: 'active', membershipVersion: 7,
    };
    await expect(new PersonaPolicy().evaluate({
      subject, action: 'settings.tenant.view', resource: { type: 'tenant', id: 'tenant-a', tenantId: 'tenant-a' },
    })).resolves.toMatchObject({ result: 'deny', reasonCode: 'ACTION_NOT_CATALOGED' });
  });

  it('输出不含敏感字段', async () => {
    const { actor, service } = rig({ actor: 'owner-1' });
    expect(JSON.stringify(await service.createSnapshot(actor, request()))).not.toMatch(/secret|token|password|externalAccount/i);
  });
});
