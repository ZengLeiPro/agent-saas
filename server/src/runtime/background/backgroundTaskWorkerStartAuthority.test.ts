import { describe, expect, it, vi } from 'vitest';

import type { RunRecord } from '../runStore.js';
import type { OrgAgentWorkerTaskLineage } from '../orgAgentTaskWorkspace.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from '../runtimeIsolationEvidence.js';
import { DurableBackgroundTaskService } from './backgroundTaskService.js';
import {
  orgAgentChannelFixture,
  orgAgentExecutionContextFixture,
} from './orgAgentExecutionContext.testFixtures.js';

function record(): RunRecord {
  const channel = orgAgentChannelFixture;
  return {
    runId: 'worker-run',
    sessionId: 'worker-session',
    userId: 'service-user',
    tenantId: 'tenant-1',
    model: 'model',
    channel: 'background_task',
    status: 'pending',
    executionTarget: 'server-remote',
    workspaceId: 'task-workspace',
    requestedAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    metadata: {
      backgroundTask: true,
      backgroundTaskType: 'agent',
      parentRunId: 'parent-run',
      parentSessionId: 'parent-session',
      parentToolCallId: 'tool-1',
      description: '执行任务',
      prompt: '执行',
      agentType: 'general',
      includeCompanyInfo: false,
      modelRef: 'models/model',
      cwd: '/task',
      workspaceId: 'task-workspace',
      sandboxScopeId: 'scope-1',
      sharedReadOnlySubPath: 'tenant-1/.agent-agent-1/shared/binding-1/wc-1',
      workOrderId: 'work-1',
      attemptId: 'attempt-1',
      attemptNo: 1,
      executionRole: 'worker',
      parentChannel: 'dingtalk',
      parentOutputTransactionMode: 'terminal_buffered',
      orgAgentChannel: channel,
      runtimeIsolationRequirement: {
        tenantId: 'tenant-1',
        taskId: 'work-1',
        runId: 'worker-run',
        sessionId: 'worker-session',
        workspaceId: 'task-workspace',
        policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
      },
    },
  } as unknown as RunRecord;
}

function lineage(): OrgAgentWorkerTaskLineage {
  const channel = orgAgentChannelFixture;
  return {
    kind: 'org_agent_task',
    tenantId: 'tenant-1',
    agentId: channel.agentId,
    accountId: channel.accountId,
    ownerWorkspaceId: channel.agentPrincipal.workspaceId,
    bindingId: channel.bindingId,
    conversationSpaceId: channel.conversationSpaceId,
    workConversationId: channel.workConversationId,
    channelConversationId: channel.channelPrincipal.conversationId,
    policyRevision: channel.policyRevision,
    workOrderId: 'work-1',
    taskRunId: 'worker-run',
    taskSessionId: 'worker-session',
    attemptId: 'attempt-1',
    attemptNo: 1,
    currentAttemptNo: 1,
    taskWorkspaceId: 'task-workspace',
    sandboxScopeId: 'scope-1',
    allowedSourceIds: channel.allowedSourceIds,
  };
}

describe('Org Worker 启动实时授权边界', () => {
  it.each([
    ['依赖缺失', 'ORG_AGENT_WORKER_LIVE_AUTHORITY_DEPENDENCY_MISSING'],
    ['requester 已撤权', 'ORG_AGENT_WORKER_TASK_AUTHORITY_REVOKED'],
  ])('%s 时在 runSubagent 前拒绝', async (_label, errorCode) => {
    const runSubagentImpl = vi.fn();
    const assertCurrent = vi.fn(async () => {
      throw new Error(errorCode);
    });
    const service = new DurableBackgroundTaskService({} as never, {
      runSubagentImpl: runSubagentImpl as never,
    });
    (service as unknown as { orgWork: Record<string, unknown> }).orgWork = {
      markRunning: vi.fn(async () => lineage()),
      createLiveTaskAuthority: vi.fn(() => ({
        taskRunId: 'worker-run',
        taskSessionId: 'worker-session',
        attemptId: 'attempt-1',
        assertCurrent,
      })),
      loadExecutionContext: vi.fn(async () => orgAgentExecutionContextFixture()),
    };

    await expect(service.execute(record())).rejects.toThrow(errorCode);
    expect(assertCurrent).toHaveBeenCalledWith('OrgAgentWorkerStart');
    expect(runSubagentImpl).not.toHaveBeenCalled();
  });
});
