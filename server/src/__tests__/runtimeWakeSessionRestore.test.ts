import { describe, expect, it, vi } from 'vitest';

import type { RunRecord } from '../runtime/runStore.js';
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

function catalog(existing: RuntimeSessionRecord | null = null): SessionCatalog & { upsert: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => existing),
    upsert: vi.fn(async () => undefined),
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
