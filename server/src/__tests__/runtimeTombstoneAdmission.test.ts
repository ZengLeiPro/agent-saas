import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createRawApprovalResumeDispatch,
  createRawInteractionResumeDispatch,
  createRawRuntimeRunDispatch,
  wakeRuntimeSession,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { RunRecord, RunStore } from '../runtime/runStore.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import type { OutboundEvent } from '../types/index.js';
import { MemorySessionCatalog as StageSessionCatalog } from './runtimeStage2.testHelpers.js';
import { MemoryEventStore, MemorySessionCatalog as WakeSessionCatalog } from './runtimeWake.testHelpers.js';

const SHARED_DIR = resolve(process.cwd(), '../workspace-shared');
const TENANT_ID = 'tenant-test';

describe('runtime tombstone fail-closed admission', () => {
  it('direct resume 对软删除 Session fail-close，且不写 Session、不 warmup、不创建 pending Run', async () => {
    const sessionId = 'deleted-direct-resume';
    const now = new Date().toISOString();
    const sessionCatalog = new StageSessionCatalog();
    await sessionCatalog.upsert({
      sessionId,
      userId: 'user-deleted',
      username: 'deleted-user',
      tenantId: TENANT_ID,
      channel: 'web',
      cwd: '/tmp/deleted-user',
      transcriptPath: '/tmp/deleted-user/session.jsonl',
      workspaceId: 'workspace-deleted',
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const upsertSession = vi.spyOn(sessionCatalog, 'upsert');
    const upsertPending = vi.fn();
    const sandboxWarmup = vi.fn();
    const dispatch = createRawRuntimeRunDispatch({
      agentCwd: '/tmp',
      sharedDir: SHARED_DIR,
      sessionCatalog,
      runStore: { upsertPending } as unknown as RunStore,
      sandboxWarmup,
      memory: { enabled: false },
    });

    const events: OutboundEvent[] = [];
    for await (const event of dispatch(
      { channel: 'web', chatId: sessionId, content: '不得复活' },
      { channel: 'web', resumeSessionId: sessionId, user: { id: 'user-deleted', username: 'deleted-user', role: 'user', tenantId: TENANT_ID } },
      { resumeSessionId: sessionId },
    )) events.push(event);

    expect(events).toEqual([{ type: 'error', error: `Session ${sessionId} 已删除，请先显式恢复会话` }]);
    expect(upsertSession).not.toHaveBeenCalled();
    expect(sandboxWarmup).not.toHaveBeenCalled();
    expect(upsertPending).not.toHaveBeenCalled();
  });

  it('approval/interaction resume 均在模型、Profile、Run 和事件副作用前 fail-close', async () => {
    const sessionId = 'deleted-pending-resume';
    const now = new Date().toISOString();
    const sessionCatalog = new StageSessionCatalog();
    await sessionCatalog.upsert({
      sessionId, userId: 'user-deleted', username: 'deleted-user', tenantId: TENANT_ID,
      channel: 'web', cwd: '/tmp/deleted-user', transcriptPath: '/tmp/deleted-user/session.jsonl',
      workspaceId: 'workspace-deleted', deletedAt: now, createdAt: now, updatedAt: now,
    });
    const upsertSession = vi.spyOn(sessionCatalog, 'upsert');
    const modelAdapterFactory = vi.fn();
    const profileResolver = vi.fn();
    const eventStoreFactory = vi.fn();
    const approvalStoreFactory = vi.fn();
    const upsertPending = vi.fn();
    const workspaceProvisioner = vi.fn();
    const config = {
      agentCwd: '/tmp', sharedDir: SHARED_DIR, sessionCatalog, modelAdapterFactory,
      agentRuntimeProfileResolver: { resolveForSession: profileResolver } as never,
      eventStoreFactory, approvalStoreFactory,
      runStore: { upsertPending } as unknown as RunStore,
      workspaceProvisioner, memory: { enabled: false },
    };
    const context = {
      channel: 'web' as const,
      user: { id: 'user-deleted', username: 'deleted-user', role: 'user' as const, tenantId: TENANT_ID },
    };
    const approvalEvents: OutboundEvent[] = [];
    for await (const event of createRawApprovalResumeDispatch(config)({
      approvalId: 'approval-deleted', response: { allow: true }, sessionId, context,
    })) approvalEvents.push(event);
    const interactionEvents: OutboundEvent[] = [];
    for await (const event of createRawInteractionResumeDispatch(config)({
      interactionId: 'interaction-deleted', response: { answers: { q1: '不得复活' } }, sessionId, context,
    })) interactionEvents.push(event);

    const expected = [{ type: 'error', error: `Session ${sessionId} 已删除，请先显式恢复会话` }];
    expect(approvalEvents).toEqual(expected);
    expect(interactionEvents).toEqual(expected);
    expect(upsertSession).not.toHaveBeenCalled();
    expect(modelAdapterFactory).not.toHaveBeenCalled();
    expect(profileResolver).not.toHaveBeenCalled();
    expect(eventStoreFactory).not.toHaveBeenCalled();
    expect(approvalStoreFactory).not.toHaveBeenCalled();
    expect(upsertPending).not.toHaveBeenCalled();
    expect(workspaceProvisioner).not.toHaveBeenCalled();
  });

  it.each(['background', 'subagent'] as const)(
    '并发软删除在 %s 专用 wake 副作用前由二次准入检查拦截',
    async (kind) => {
      const now = new Date().toISOString();
      const active: RuntimeSessionRecord = {
        sessionId: `session-concurrent-delete-${kind}`, userId: 'user-1', username: 'alice',
        tenantId: TENANT_ID, channel: 'web', cwd: '/tmp/alice', transcriptPath: `/tmp/alice/${kind}.jsonl`,
        workspaceId: 'workspace-delete-race', ...(kind === 'subagent' ? { kind: 'subagent' as const } : {}),
        createdAt: now, updatedAt: now,
      };
      const tombstone = { ...active, deletedAt: now };
      const sessionCatalog = new WakeSessionCatalog(active);
      vi.spyOn(sessionCatalog, 'get').mockResolvedValueOnce(active).mockResolvedValue(tombstone);
      const executeBackground = vi.fn(async () => undefined);
      const eventStoreFactory = vi.fn(() => new MemoryEventStore());
      const release = vi.fn(async () => undefined);
      const run: RunRecord = {
        runId: `run-concurrent-delete-${kind}`, sessionId: active.sessionId,
        userId: active.userId, tenantId: TENANT_ID, status: 'running', channel: 'web',
        requestedAt: now, updatedAt: now,
        metadata: kind === 'background' ? { backgroundTask: true } : { subagent: true },
      };

      await wakeRuntimeSession({
        agentCwd: '/tmp', sharedDir: '/tmp', sessionCatalog, eventStoreFactory,
        backgroundTasks: { execute: executeBackground } as never,
      }, run, { lease: { runId: run.runId, workerId: 'worker-1', renew: async () => undefined, release } });

      expect(release).toHaveBeenCalledWith('cancelled', 'session_deleted_before_wake');
      expect(executeBackground).not.toHaveBeenCalled();
      expect(eventStoreFactory).not.toHaveBeenCalled();
    },
  );

  it('并发软删除在普通 wake 注册与 dispatch 前由二次准入检查拦截', async () => {
    const now = new Date().toISOString();
    const active: RuntimeSessionRecord = {
      sessionId: 'session-concurrent-delete-ordinary', userId: 'user-1', username: 'alice',
      tenantId: TENANT_ID, channel: 'web', cwd: '/tmp/alice', transcriptPath: '/tmp/alice/ordinary.jsonl',
      workspaceId: 'workspace-delete-race', createdAt: now, updatedAt: now,
    };
    const tombstone = { ...active, deletedAt: now };
    const sessionCatalog = new WakeSessionCatalog(active);
    vi.spyOn(sessionCatalog, 'get').mockResolvedValueOnce(active).mockResolvedValue(tombstone);
    const eventStoreFactory = vi.fn(() => new MemoryEventStore());
    const modelAdapterFactory = vi.fn();
    const release = vi.fn(async () => undefined);
    const run: RunRecord = {
      runId: 'run-concurrent-delete-ordinary', sessionId: active.sessionId,
      userId: active.userId, tenantId: TENANT_ID, status: 'running', channel: 'web',
      requestedAt: now, updatedAt: now, metadata: {},
    };

    await wakeRuntimeSession({
      agentCwd: '/tmp', sharedDir: '/tmp', sessionCatalog, eventStoreFactory,
      modelAdapterFactory: modelAdapterFactory as never,
      memory: { enabled: false },
    }, run, { lease: { runId: run.runId, workerId: 'worker-1', renew: async () => undefined, release } });

    expect(release).toHaveBeenCalledWith('cancelled', 'session_deleted_before_wake');
    expect(modelAdapterFactory).not.toHaveBeenCalled();
  });

  it('缺身份的软删除 Session 在回填/provision/background/subagent/model 前 release cancelled', async () => {
    const now = new Date().toISOString();
    const session: RuntimeSessionRecord = {
      sessionId: 'session-deleted-wake',
      userId: '',
      username: 'alice',
      channel: 'web',
      cwd: '/tmp/alice',
      transcriptPath: '/tmp/alice/deleted.jsonl',
      workspaceId: 'workspace-deleted',
      status: 'running',
      kind: 'subagent',
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const run: RunRecord = {
      runId: 'run-deleted-wake',
      sessionId: session.sessionId,
      userId: 'user-1',
      tenantId: TENANT_ID,
      status: 'running',
      channel: 'web',
      requestedAt: now,
      updatedAt: now,
      metadata: { backgroundTask: true },
    };
    const release = vi.fn(async () => undefined);
    const executeBackground = vi.fn(async () => undefined);
    const workspaceProvisioner = vi.fn(async () => undefined);
    const eventStoreFactory = vi.fn(() => new MemoryEventStore());
    const modelAdapterFactory = vi.fn();
    const sessionCatalog = new WakeSessionCatalog(session);
    const upsertSession = vi.spyOn(sessionCatalog, 'upsert');

    await wakeRuntimeSession({
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      sessionCatalog,
      eventStoreFactory,
      backgroundTasks: { execute: executeBackground } as never,
      workspaceProvisioner,
      modelAdapterFactory: modelAdapterFactory as never,
    }, run, {
      lease: { runId: run.runId, workerId: 'worker-1', renew: async () => undefined, release },
    });

    expect(release).toHaveBeenCalledWith('cancelled', 'session_deleted_before_wake');
    expect(upsertSession).not.toHaveBeenCalled();
    expect(executeBackground).not.toHaveBeenCalled();
    expect(workspaceProvisioner).not.toHaveBeenCalled();
    expect(eventStoreFactory).not.toHaveBeenCalled();
    expect(modelAdapterFactory).not.toHaveBeenCalled();
  });
});
