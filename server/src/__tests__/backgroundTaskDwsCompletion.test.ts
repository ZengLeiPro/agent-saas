import { describe, expect, it, vi } from 'vitest';

import {
  deliverDwsBackgroundCompletion,
  resolveDwsCompletionRoute,
} from '../runtime/background/backgroundTaskDwsCompletion.js';
import type { RunRecord } from '../runtime/runStore.js';

function parentRun(metadata: Record<string, unknown>): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: 'parent-run', sessionId: 'parent-session', userId: 'user-1', tenantId: 'tenant-1',
    status: 'running', requestedAt: now, updatedAt: now, metadata,
  };
}

describe('background task DWS completion route', () => {
  it('pins the original account, conversation and sender from the durable parent Run', () => {
    const route = resolveDwsCompletionRoute(parentRun({
      wakeMessage: {
        channel: 'dingtalk', chatId: 'cid-1', senderId: 'open-user-1',
        metadata: {
          source: 'agent_dws_personal_stream', accountId: 'adws-1',
          eventType: 'user_im_message_receive_o2o_all', messageId: 'msg-1',
        },
      },
    }), 'dingtalk');
    expect(route).toEqual({
      accountId: 'adws-1', conversationId: 'cid-1', eventType: 'user_im_message_receive_o2o_all',
      messageId: 'msg-1', senderOpenDingtalkId: 'open-user-1',
    });
  });

  it('fails closed for non-DWS or incomplete metadata', () => {
    expect(resolveDwsCompletionRoute(parentRun({}), 'dingtalk')).toBeUndefined();
    expect(resolveDwsCompletionRoute(parentRun({ wakeMessage: {} }), 'web')).toBeUndefined();
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
        accountId: 'adws-1', conversationId: 'cid-1', eventType: 'user_im_message_receive_o2o_all' as const,
      },
    };
    await expect(deliverDwsBackgroundCompletion({
      config: { enqueueDwsBackgroundCompletion } as never,
      runStore: { finishBackgroundTaskWake } as never,
      task, metadata, claimToken: 'claim-1',
    })).resolves.toBe(true);
    expect(enqueueDwsBackgroundCompletion).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', taskId: 'bg-1', accountId: 'adws-1',
      content: expect.stringContaining('<task-id>T-1234ABCD</task-id>'),
    }));
    expect(finishBackgroundTaskWake).toHaveBeenCalledWith(
      'bg-1', 'claim-1', 'queued', expect.objectContaining({ wakeRunId: 'agent-dws-background-completion:bg-1' }),
    );
  });
});
