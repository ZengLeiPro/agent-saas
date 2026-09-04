import { describe, expect, it, vi } from 'vitest';

import type { ToolCallContext } from '../agent/toolRuntime.js';
import { DurableBackgroundTaskService } from '../runtime/background/backgroundTaskService.js';
import type { RunRecord, UpsertRunInput } from '../runtime/runStore.js';

function createFixture() {
  const records = new Map<string, RunRecord>();
  const sessions = new Map([['parent-session-1', {
    sessionId: 'parent-session-1', userId: 'user-1', username: 'alice', userRole: 'user',
    tenantId: 'tenant-1', channel: 'dingtalk', cwd: '/tmp/workspace',
    modelRef: 'group/model', executionTarget: 'server-container', workspaceId: 'parent-session-1',
    status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }]]);
  const upsertPending = async (input: UpsertRunInput) => {
    const existing = records.get(input.runId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: input.runId, sessionId: input.sessionId, userId: input.userId, tenantId: input.tenantId,
      status: 'pending', model: input.model, channel: input.channel, requestedAt: now, updatedAt: now,
      executionTarget: input.executionTarget, workspaceId: input.workspaceId, metadata: input.metadata ?? {},
    };
    records.set(record.runId, record);
    return record;
  };
  const markStatus = async (
    runId: string,
    status: RunRecord['status'],
    statusReason?: string,
    metadataPatch: Record<string, unknown> = {},
  ) => {
    const record = records.get(runId);
    if (!record) return null;
    const updated = {
      ...record, status, statusReason, metadata: { ...record.metadata, ...metadataPatch },
    };
    records.set(runId, updated);
    return updated;
  };
  const runStore = {
    upsertPending,
    enqueueBackgroundTask: upsertPending,
    listBackgroundTasks: async () => [...records.values()].filter(record => record.metadata.backgroundTask === true),
    get: async (runId: string) => records.get(runId) ?? null,
    markStatus,
    getActiveBySession: async (sessionId: string) => [...records.values()].find(record => (
      record.sessionId === sessionId && ['pending', 'running'].includes(record.status)
    )) ?? null,
    listPendingBackgroundTaskWakes: async () => [...records.values()].filter(record => (
      record.metadata.backgroundTask === true
      && record.status === 'completed'
      && record.metadata.wakeState === 'pending'
    )),
    claimBackgroundTaskWake: async (runId: string, claimToken: string) => {
      const record = records.get(runId);
      if (!record || record.metadata.wakeState !== 'pending') return null;
      return markStatus(runId, record.status, record.statusReason, {
        wakeState: 'delivering', wakeClaimToken: claimToken,
      });
    },
    finishBackgroundTaskWake: async (
      runId: string,
      claimToken: string,
      wakeState: 'pending' | 'queued' | 'discarded',
      metadataPatch: Record<string, unknown>,
    ) => {
      const record = records.get(runId);
      if (!record || record.metadata.wakeClaimToken !== claimToken) return null;
      return markStatus(runId, record.status, record.statusReason, {
        ...metadataPatch, wakeState, wakeClaimToken: null,
      });
    },
  };
  const config = {
    runStore,
    sessionCatalog: {
      get: async (sessionId: string) => sessions.get(sessionId) ?? null,
      upsert: async (record: { sessionId: string }) => { sessions.set(record.sessionId, record as never); },
    },
    eventStoreFactory: () => ({ append: vi.fn(async input => input) }),
  };
  return { records, runStore, sessions, config,
    service: new DurableBackgroundTaskService(config as never) };
}

describe('DurableBackgroundTaskService DWS route persistence', () => {
  it('delivers an exact DWS completion after the requester parent session is gone', async () => {
    const base = createFixture();
    const enqueueDwsBackgroundCompletion = vi.fn(async () => undefined);
    Object.assign(base.config, { enqueueDwsBackgroundCompletion });
    const parent = await base.runStore.upsertPending({
      runId: 'parent-dws-exact', sessionId: 'parent-session-1', userId: 'user-1',
      tenantId: 'tenant-1', model: 'group/model', channel: 'dingtalk',
      metadata: { wakeMessage: { channel: 'dingtalk', chatId: 'cid-1', senderId: 'sender-1',
        metadata: { source: 'agent_dws_personal_stream', accountId: 'adws-1',
          profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
          eventType: 'user_im_message_receive_o2o_all' } } },
    });
    const context: ToolCallContext = {
      channelContext: { channel: 'dingtalk',
        sessionOwner: { id: 'user-1', username: 'alice', role: 'user', tenantId: 'tenant-1' } },
      workspace: { id: 'parent-session-1', root: '/tmp/workspace', userId: 'user-1', username: 'alice',
        tenantId: 'tenant-1', sessionId: 'parent-session-1', executionTarget: 'server-container' },
      sessionId: 'parent-session-1', runId: parent.runId, toolCallId: 'tool-call-exact-dws',
    };
    const started = await base.service.enqueue(context, {
      description: '原会话删除仍回群', prompt: '执行任务', agentType: 'general', includeCompanyInfo: false,
    });
    base.sessions.delete('parent-session-1');
    await base.runStore.markStatus(started.taskId, 'completed', undefined, {
      wakeState: 'pending',
      backgroundResult: { status: 'completed', text: 'done', totalTokens: 1,
        toolUseCount: 0, turnCount: 1, durationMs: 1 },
    });

    await base.service.reconcileWakeDeliveries();

    expect(enqueueDwsBackgroundCompletion).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', taskId: started.taskId, accountId: 'adws-1', conversationId: 'cid-1',
    }));
    expect(base.records.get(started.taskId)?.metadata).toMatchObject({
      wakeState: 'queued', wakeRunId: `agent-dws-background-completion:${started.taskId}`,
    });
  });

  it('persists an invalid DWS route at enqueue and discards completion without Web fallback', async () => {
    const base = createFixture();
    const parent = await base.runStore.upsertPending({
      runId: 'parent-dws-invalid', sessionId: 'parent-session-1', userId: 'user-1',
      tenantId: 'tenant-1', model: 'group/model', channel: 'dingtalk',
      metadata: {
        wakeMessage: {
          channel: 'dingtalk', chatId: 'cid-1',
          metadata: {
            source: 'agent_dws_personal_stream', accountId: 'adws-1', corpId: 'corp-1',
            dingtalkUserId: 'user-1', eventType: 'user_im_message_receive_o2o_all',
          },
        },
      },
    });
    const context: ToolCallContext = {
      channelContext: {
        channel: 'dingtalk',
        sessionOwner: { id: 'user-1', username: 'alice', role: 'user', tenantId: 'tenant-1' },
      },
      workspace: {
        id: 'parent-session-1', root: '/tmp/workspace', userId: 'user-1', username: 'alice',
        tenantId: 'tenant-1', sessionId: 'parent-session-1', executionTarget: 'server-container',
      },
      sessionId: 'parent-session-1', runId: parent.runId, toolCallId: 'tool-call-invalid-dws',
    };

    const started = await base.service.enqueue(context, {
      description: '无效路由回归', prompt: '执行任务', agentType: 'general', includeCompanyInfo: false,
    });
    expect(base.records.get(started.taskId)?.metadata).toMatchObject({
      dwsCompletionRouteVersion: 'invalid', wakeState: 'none',
    });

    await base.runStore.markStatus(parent.runId, 'completed');
    await base.runStore.markStatus(started.taskId, 'completed', undefined, {
      wakeState: 'pending',
      backgroundResult: {
        status: 'completed', text: 'done', totalTokens: 1, toolUseCount: 0, turnCount: 1, durationMs: 1,
      },
    });
    await base.service.reconcileWakeDeliveries();

    expect(base.records.get(started.taskId)?.metadata).toMatchObject({
      wakeState: 'discarded', wakeDiscardReason: 'dws_completion_route_invalid',
    });
    expect(base.records.has(`bg-wake-${started.taskId}`)).toBe(false);
  });
});
