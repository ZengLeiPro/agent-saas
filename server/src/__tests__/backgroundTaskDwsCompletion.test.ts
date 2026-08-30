import { describe, expect, it, vi } from 'vitest';

import { createDwsBackgroundCompletionEnqueuer } from '../app/orgAgentDispatcherRuntime.js';
import {
  deliverDwsBackgroundCompletion,
  resolveDwsCompletionRoute,
} from '../runtime/background/backgroundTaskDwsCompletion.js';
import { parseDwsCompletionRoute } from '../runtime/background/backgroundTaskMetadata.js';
import type { RunRecord } from '../runtime/runStore.js';

function parentRun(metadata: Record<string, unknown>): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: 'parent-run', sessionId: 'parent-session', userId: 'user-1', tenantId: 'tenant-1',
    status: 'running', requestedAt: now, updatedAt: now, metadata,
  };
}

function legacyCompletionMetadata() {
  return {
    taskType: 'agent' as const,
    parentRunId: 'parent-run', parentSessionId: 'parent-session', parentToolCallId: 'call-1',
    shortTaskId: 'T-1234ABCD', description: '执行任务', modelRef: 'model', cwd: '/workspace',
    workspaceId: 'ws-1', parentChannel: 'dingtalk' as const, outputTransactionMode: 'terminal_buffered' as const,
    parentOutputTransactionMode: 'terminal_buffered' as const,
    prompt: '执行', agentType: 'general' as const, includeCompanyInfo: false,
    dwsCompletionRouteVersion: 'legacy' as const,
    legacyDwsCompletionRoute: {
      accountId: 'adws-1', conversationId: 'cid-1',
      eventType: 'user_im_message_receive_o2o_all' as const,
    },
  };
}

describe('background task DWS completion route', () => {
  it('version-parses exact, legacy and invalid durable routes without dropping legacy', () => {
    expect(parseDwsCompletionRoute({
      accountId: 'adws-1', profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
      conversationId: 'cid-1', eventType: 'user_im_message_receive_o2o_all',
    })).toMatchObject({ version: 'exact', route: { profileId: 'corp-1:user-1' } });
    expect(parseDwsCompletionRoute({
      accountId: 'adws-1', conversationId: 'cid-1', eventType: 'user_im_message_receive_o2o_all',
    })).toEqual({
      version: 'legacy',
      route: { accountId: 'adws-1', conversationId: 'cid-1', eventType: 'user_im_message_receive_o2o_all' },
    });
    expect(parseDwsCompletionRoute({
      accountId: 'adws-1', profileId: 'corp-1:user-1', conversationId: 'cid-1',
      eventType: 'user_im_message_receive_o2o_all',
    })).toEqual({ version: 'invalid' });
  });

  it('pins the original account, conversation and sender from the durable parent Run', () => {
    const route = resolveDwsCompletionRoute(parentRun({
      wakeMessage: {
        channel: 'dingtalk', chatId: 'cid-1', senderId: 'open-user-1',
        metadata: {
          source: 'agent_dws_personal_stream', accountId: 'adws-1',
          profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
          eventType: 'user_im_message_receive_o2o_all', messageId: 'msg-1',
        },
      },
    }), 'dingtalk');
    expect(route).toEqual({
      accountId: 'adws-1', profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
      conversationId: 'cid-1', eventType: 'user_im_message_receive_o2o_all',
      messageId: 'msg-1', senderOpenDingtalkId: 'open-user-1',
    });
  });

  it('fails closed for non-DWS, incomplete or inconsistent account identity metadata', () => {
    expect(resolveDwsCompletionRoute(parentRun({}), 'dingtalk')).toBeUndefined();
    expect(resolveDwsCompletionRoute(parentRun({ wakeMessage: {} }), 'web')).toBeUndefined();
    expect(resolveDwsCompletionRoute(parentRun({
      wakeMessage: {
        channel: 'dingtalk', chatId: 'cid-1',
        metadata: {
          source: 'agent_dws_personal_stream', accountId: 'adws-1',
          profileId: 'corp-1:user-2', corpId: 'corp-1', dingtalkUserId: 'user-1',
          eventType: 'user_im_message_receive_o2o_all',
        },
      },
    }), 'dingtalk')).toBeUndefined();
  });

  it('enqueues background completion with the pinned exact account identity', async () => {
    const ingest = vi.fn(async () => ({ record: {} as never, created: true }));
    const enqueue = createDwsBackgroundCompletionEnqueuer({ ingest } as never);

    await enqueue({
      tenantId: 'tenant-1', taskId: 'bg-1', accountId: 'adws-1',
      profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
      conversationId: 'cid-1', eventType: 'user_im_message_receive_o2o_all', content: 'done',
    });

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'adws-1' }), {
      schemaVersion: 2,
      source: 'background_task_completion',
      backgroundTaskId: 'bg-1',
      accountIdentity: {
        profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
      },
    });
  });

  it('rejects an inconsistent background completion identity before inbox ingest', async () => {
    const ingest = vi.fn();
    const enqueue = createDwsBackgroundCompletionEnqueuer({ ingest } as never);

    await expect(enqueue({
      tenantId: 'tenant-1', taskId: 'bg-1', accountId: 'adws-1',
      profileId: 'corp-1:user-2', corpId: 'corp-1', dingtalkUserId: 'user-1',
      conversationId: 'cid-1', eventType: 'user_im_message_receive_o2o_all', content: 'done',
    })).rejects.toThrow('account identity is invalid');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('delivers through durable inbox and freezes the wake as queued', async () => {
    const enqueueDwsBackgroundCompletion = vi.fn(async () => undefined);
    const finishBackgroundTaskWake = vi.fn(async () => null);
    const task = { ...parentRun({}), runId: 'bg-1', tenantId: 'tenant-1' };
    const metadata = {
      taskType: 'agent' as const,
      parentRunId: 'parent-run', parentSessionId: 'parent-session', parentToolCallId: 'call-1',
      shortTaskId: 'T-1234ABCD', description: '执行任务', modelRef: 'model', cwd: '/workspace',
      workspaceId: 'ws-1', parentChannel: 'dingtalk' as const, outputTransactionMode: 'terminal_buffered' as const,
      parentOutputTransactionMode: 'terminal_buffered' as const,
      prompt: '执行', agentType: 'general' as const, includeCompanyInfo: false,
      dwsCompletionRoute: {
        accountId: 'adws-1', profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
        conversationId: 'cid-1', eventType: 'user_im_message_receive_o2o_all' as const,
      },
    };
    await expect(deliverDwsBackgroundCompletion({
      config: { enqueueDwsBackgroundCompletion } as never,
      runStore: { finishBackgroundTaskWake } as never,
      task, metadata, claimToken: 'claim-1',
    })).resolves.toBe(true);
    expect(enqueueDwsBackgroundCompletion).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', taskId: 'bg-1', accountId: 'adws-1',
      profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
      content: expect.stringContaining('<task-id>T-1234ABCD</task-id>'),
    }));
    expect(finishBackgroundTaskWake).toHaveBeenCalledWith(
      'bg-1', 'claim-1', 'queued', expect.objectContaining({ wakeRunId: 'agent-dws-background-completion:bg-1' }),
    );
  });

  it('reconciles an unchanged legacy route to exact identity and consumes the wake without web fallback', async () => {
    const enqueueDwsBackgroundCompletion = vi.fn(async () => undefined);
    const finishBackgroundTaskWake = vi.fn(async () => null);
    const task = {
      ...parentRun({}), runId: 'bg-legacy', tenantId: 'tenant-1',
      requestedAt: '2026-08-30T00:00:00.000Z',
    };
    await expect(deliverDwsBackgroundCompletion({
      config: {
        enqueueDwsBackgroundCompletion,
        resolveLegacyDwsCompletionAccount: vi.fn(async () => ({
          accountId: 'adws-1', status: 'active', profileId: 'corp-1:user-1',
          corpId: 'corp-1', dingtalkUserId: 'user-1', updatedAt: '2026-08-29T23:59:59.000Z',
        })),
      } as never,
      runStore: { finishBackgroundTaskWake } as never,
      task, metadata: legacyCompletionMetadata(), claimToken: 'claim-legacy',
    })).resolves.toBe(true);

    expect(enqueueDwsBackgroundCompletion).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'adws-1', profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
    }));
    expect(finishBackgroundTaskWake).toHaveBeenCalledWith(
      'bg-legacy', 'claim-legacy', 'queued', expect.objectContaining({
        dwsCompletionReconciliation: { status: 'succeeded', routeVersion: 'legacy', reconciledAt: expect.any(String) },
      }),
    );
  });

  it('discards a legacy route when the account changed and consumes the wake without web fallback', async () => {
    const enqueueDwsBackgroundCompletion = vi.fn(async () => undefined);
    const finishBackgroundTaskWake = vi.fn(async () => null);
    const task = {
      ...parentRun({}), runId: 'bg-legacy', tenantId: 'tenant-1',
      requestedAt: '2026-08-30T00:00:00.000Z',
    };
    await expect(deliverDwsBackgroundCompletion({
      config: {
        enqueueDwsBackgroundCompletion,
        resolveLegacyDwsCompletionAccount: vi.fn(async () => ({
          accountId: 'adws-1', status: 'active', profileId: 'corp-2:user-2',
          corpId: 'corp-2', dingtalkUserId: 'user-2', updatedAt: '2026-08-30T00:00:01.000Z',
        })),
      } as never,
      runStore: { finishBackgroundTaskWake } as never,
      task, metadata: legacyCompletionMetadata(), claimToken: 'claim-legacy',
    })).resolves.toBe(true);

    expect(enqueueDwsBackgroundCompletion).not.toHaveBeenCalled();
    expect(finishBackgroundTaskWake).toHaveBeenCalledWith(
      'bg-legacy', 'claim-legacy', 'discarded', expect.objectContaining({
        wakeDiscardReason: 'dws_completion_legacy_identity_changed_since_request',
        dwsCompletionReconciliation: expect.objectContaining({ status: 'failed', routeVersion: 'legacy' }),
      }),
    );
  });
});
