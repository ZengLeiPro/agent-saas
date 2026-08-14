import { describe, expect, it, vi } from 'vitest';

import type { SessionIdentityBackfill } from '../data/transcripts/meta.js';
import type { RunRecord } from '../runtime/runStore.js';
import { resolveWakeSessionOwner, type RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';
import { restoreRuntimeSessionForWake } from '../runtime/runtimeWakeSessionRestore.js';

function run(metadata: Record<string, unknown> = {}): RunRecord {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    userId: 'account-1',
    tenantId: 'kaiyan',
    status: 'running',
    model: 'gpt-5.6-sol',
    channel: 'dingtalk',
    requestedAt: '2026-08-14T08:00:00.000Z',
    updatedAt: '2026-08-14T08:00:00.000Z',
    executionTarget: 'server-container',
    workspaceId: 'ws_kaiyan__account-1',
    metadata,
  };
}

function catalog(existing: RuntimeSessionRecord | null = null): SessionCatalog & {
  upsert: ReturnType<typeof vi.fn>;
  backfillIdentity: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => existing),
    upsert: vi.fn(async () => undefined),
    backfillIdentity: vi.fn(async (_sessionId: string, identity: SessionIdentityBackfill) => existing ? ({
      ...existing,
      userId: existing.userId || identity.userId || '',
      ...(!existing.tenantId && identity.tenantId ? { tenantId: identity.tenantId } : {}),
      ...(!existing.orgAgentId && identity.orgAgentId ? { orgAgentId: identity.orgAgentId } : {}),
      updatedAt: identity.updatedAt,
    }) : null),
    ensure: vi.fn(async () => undefined),
    markStatus: vi.fn(async () => undefined),
    findTranscriptPath: vi.fn(async () => null),
  };
}

describe('restoreRuntimeSessionForWake', () => {
  it('优先使用已有 Session，不改写文件投影', async () => {
    const existing: RuntimeSessionRecord = {
      sessionId: 'session-1', userId: 'account-1', username: 'agent-dws:org-kaikai',
      tenantId: 'kaiyan', channel: 'dingtalk', cwd: '/workspace/kaiyan/.agent-org-kaikai',
      transcriptPath: '/data/session-1.jsonl', workspaceId: 'ws_kaiyan__account-1',
      status: 'running', createdAt: '2026-08-14T08:00:00.000Z', updatedAt: '2026-08-14T08:00:00.000Z',
    };
    const store = catalog(existing);

    await expect(restoreRuntimeSessionForWake(store, run())).resolves.toBe(existing);
    expect(store.backfillIdentity).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('通道或展示用户名变化时不误判为授权身份冲突', async () => {
    const existing: RuntimeSessionRecord = {
      sessionId: 'session-1', userId: 'account-1', username: 'legacy-agent',
      tenantId: 'kaiyan', orgAgentId: 'org-kaikai', channel: 'web',
      cwd: '/workspace/kaiyan/.agent-org-kaikai', transcriptPath: '/data/session-1.jsonl',
      workspaceId: 'ws_kaiyan__account-1', status: 'running',
      createdAt: '2026-08-14T08:00:00.000Z', updatedAt: '2026-08-14T08:00:00.000Z',
    };
    const store = catalog(existing);

    await expect(restoreRuntimeSessionForWake(store, run({
      username: 'agent-dws:org-kaikai', orgAgentId: 'org-kaikai',
    }))).resolves.toBe(existing);
    expect(store.backfillIdentity).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('仅 DWS service identity 使用 durable Run tenant，真人组织 Agent 不绕过 UserStore', () => {
    const serviceSession: RuntimeSessionRecord = {
      sessionId: 'session-1', userId: 'adws-account-1', username: 'agent-dws:org-kaikai',
      orgAgentId: 'org-kaikai', channel: 'dingtalk', cwd: '/tmp/org-kaikai',
      transcriptPath: '/tmp/org-kaikai/session.jsonl', workspaceId: 'workspace-1',
      createdAt: '2026-08-14T08:00:00.000Z', updatedAt: '2026-08-14T08:00:00.000Z',
    };
    const resolver = vi.fn(() => undefined);
    const config = { agentCwd: '/tmp', sharedDir: '/tmp', resolveUserTenantId: resolver } as RawRuntimeRunDispatchConfig;

    expect(resolveWakeSessionOwner(config, serviceSession, serviceSession.userId, 'kaiyan').tenantId).toBe('kaiyan');
    expect(resolver).not.toHaveBeenCalled();
    const humanSession = { ...serviceSession, userId: 'human-1', username: 'alice' };
    expect(resolveWakeSessionOwner(config, humanSession, humanSession.userId, 'kaiyan').tenantId).toBeUndefined();
    expect(resolver).toHaveBeenCalledWith({ userId: 'human-1', username: 'alice' });
    expect(resolveWakeSessionOwner(config, serviceSession, serviceSession.userId).tenantId).toBeUndefined();
  });

  it('已有 Session 缺治理身份时从同一 durable Run 安全补齐', async () => {
    const existing: RuntimeSessionRecord = {
      sessionId: 'session-1', userId: '', username: 'agent-dws:org-kaikai',
      channel: 'dingtalk', cwd: '/workspace/kaiyan/.agent-org-kaikai',
      transcriptPath: '/data/session-1.jsonl', workspaceId: 'ws_kaiyan__account-1',
      status: 'running', createdAt: '2026-08-14T08:00:00.000Z', updatedAt: '2026-08-14T08:00:00.000Z',
    };
    const store = catalog(existing);
    const restored = await restoreRuntimeSessionForWake(store, run({
      username: 'agent-dws:org-kaikai',
      orgAgentId: 'org-kaikai',
    }));

    expect(restored).toMatchObject({
      sessionId: 'session-1', userId: 'account-1', username: 'agent-dws:org-kaikai',
      tenantId: 'kaiyan', orgAgentId: 'org-kaikai', channel: 'dingtalk',
    });
    expect(restored?.createdAt).toBe(existing.createdAt);
    expect(store.backfillIdentity).toHaveBeenCalledWith('session-1', expect.objectContaining({
      userId: 'account-1', tenantId: 'kaiyan', orgAgentId: 'org-kaikai',
    }));
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['userId', { userId: 'other-account' }],
    ['tenantId', { tenantId: 'other-tenant' }],
    ['orgAgentId', { orgAgentId: 'other-agent' }],
  ] as Array<[string, Partial<RuntimeSessionRecord>]>)('已有 Session 的 %s 与 durable Run 冲突时 fail-closed', async (field, override) => {
    const existing: RuntimeSessionRecord = {
      sessionId: 'session-1', userId: 'account-1', username: 'agent-dws:org-kaikai',
      tenantId: 'kaiyan', orgAgentId: 'org-kaikai', channel: 'dingtalk',
      cwd: '/workspace/kaiyan/.agent-org-kaikai', transcriptPath: '/data/session-1.jsonl',
      workspaceId: 'ws_kaiyan__account-1', status: 'running',
      createdAt: '2026-08-14T08:00:00.000Z', updatedAt: '2026-08-14T08:00:00.000Z',
      ...override,
    };
    const store = catalog(existing);

    await expect(restoreRuntimeSessionForWake(store, run({
      username: 'agent-dws:org-kaikai',
      orgAgentId: 'org-kaikai',
    }))).rejects.toThrow(`WAKE_SESSION_IDENTITY_CONFLICT:${field}`);
    expect(store.backfillIdentity).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('文件投影缺失时从 durable Run metadata 重建组织 Agent Session', async () => {
    const store = catalog();
    const restored = await restoreRuntimeSessionForWake(store, run({
      cwd: '/workspace/kaiyan/.agent-org-kaikai',
      transcriptPath: '/data/session-1.jsonl',
      modelRef: 'codex/gpt-5.6-sol-high',
      username: 'agent-dws:org-kaikai',
      userRole: 'user',
      orgAgentId: 'org-kaikai',
      profile: {
        profileId: 'arp_system_org_agent', profileKey: 'org_agent_default',
        profileVersionId: 'arpv-1', versionNumber: 1, configDigest: 'digest-1',
        bindingKey: 'org_agent', resolution: 'builtin',
      },
    }));

    expect(restored).toMatchObject({
      sessionId: 'session-1', userId: 'account-1', username: 'agent-dws:org-kaikai',
      tenantId: 'kaiyan', orgAgentId: 'org-kaikai', modelRef: 'codex/gpt-5.6-sol-high',
      executionTarget: 'server-container', workspaceId: 'ws_kaiyan__account-1',
      profileId: 'arp_system_org_agent', profileBindingKey: 'org_agent', profileResolution: 'builtin',
    });
    expect(store.upsert).toHaveBeenCalledWith(restored);
  });

  it('关键恢复字段不完整时 fail-closed，不伪造 Session', async () => {
    const store = catalog();
    await expect(restoreRuntimeSessionForWake(store, run({
      cwd: '/workspace/kaiyan/.agent-org-kaikai',
      transcriptPath: '/data/session-1.jsonl',
    }))).resolves.toBeNull();
    expect(store.upsert).not.toHaveBeenCalled();
  });
});
