import { describe, expect, it, vi } from 'vitest';

import { DurableBackgroundTaskService } from '../runtime/background/backgroundTaskService.js';

const orgChannel = {
  bindingId: 'binding-1',
  accountId: 'account-1',
  agentId: 'agent-1',
  conversationSpaceId: 'space-1',
  workConversationId: 'conversation-1',
  policyRevision: 1,
  agentPrincipal: {
    kind: 'org_agent',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    accountId: 'account-1',
    workspaceId: 'agent-workspace-1',
  },
  externalActorAssurance: 'mapped',
  allowedToolNames: ['Agent'],
  allowedSkillIds: [],
  allowedSourceIds: [],
  contextEnabled: false,
  taskVisibility: 'conversation',
  actorRole: 'member',
  triggerRoles: [],
  approvalRoles: [],
  externalActor: {
    kind: 'external_user',
    provider: 'dingtalk',
    corpId: 'corp-1',
    openId: 'user-open-1',
    mappedUserId: 'user-1',
    assurance: 'mapped',
    role: 'member',
  },
  channelPrincipal: {
    provider: 'dingtalk',
    accountId: 'account-1',
    conversationId: 'group-1',
    kind: 'group',
  },
};

function stagedRun(index: number) {
  const id = `run-${index}`;
  return {
    runId: id,
    sessionId: `session-${index}`,
    tenantId: 'tenant-1',
    status: 'pending',
    model: 'model-1',
    channel: 'background_task',
    requestedAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    metadata: {
      backgroundTask: true,
      backgroundTaskType: 'agent',
      backgroundTaskVersion: 2,
      backgroundTaskReady: false,
      parentRunId: 'parent-run',
      parentSessionId: 'parent-session',
      parentToolCallId: `tool-${index}`,
      description: '执行',
      prompt: '执行',
      agentType: 'general',
      modelRef: 'models/model-1',
      cwd: `/tasks/${id}`,
      workspaceId: `workspace-${id}`,
      mountSubPath: `workspaces/task/${id}`,
      sandboxScopeId: `sandbox-${id}`,
      sharedReadOnlySubPath: 'workspaces/agent/shared/binding-1/conversation-1',
      workOrderId: `work-${index}`,
      attemptId: `attempt-${index}`,
      attemptNo: 1,
      parentChannel: 'dingtalk',
      parentOutputTransactionMode: 'terminal_buffered',
      outputTransactionMode: 'terminal_buffered',
      includeCompanyInfo: false,
      orgAgentChannel: orgChannel,
    },
  } as never;
}

describe('组织 Agent staged run 恢复', () => {
  it('先排空所有 staged run，再检查无 run 的孤儿 WorkOrder', async () => {
    const runs: any[] = Array.from({ length: 51 }, (_, index) => stagedRun(index + 1));
    const listStaged = vi
      .fn()
      .mockResolvedValueOnce(runs.slice(0, 50))
      .mockResolvedValueOnce(runs.slice(50));
    const activate = vi.fn(async (runId, _reason, patch) => ({
      ...runs.find((item) => item.runId === runId),
      metadata: { ...(runs.find((item) => item.runId === runId) as any).metadata,
        ...patch, backgroundTaskReady: true },
    }));
    const created = new Set<string>();
    const createWorkAttempt = vi.fn(async (input) => ({
      ...input,
      attemptNo: 1,
      status: 'queued',
    })).mockImplementation(async input => {
      created.add(input.workOrderId);
      return { ...input, attemptNo: 1, status: 'queued' };
    });
    const listStagedWorkOrders = vi.fn().mockResolvedValue([]);
    const service = new DurableBackgroundTaskService({
      runStore: {
        listStagedOrgAgentBackgroundTasks: listStaged,
        activateStagedOrgAgentBackgroundTask: activate,
        markStatusIfCurrent: vi.fn(async () => null),
        get: vi.fn(),
      },
      orgGroupAgentStore: {
        getWorkOrder: vi.fn(async (_tenantId, workOrderId) => ({
          workOrderId,
          tenantId: 'tenant-1',
          state: created.has(workOrderId) ? 'running' : 'queued',
          currentAttemptNo: created.has(workOrderId) ? 1 : 0,
        })),
        listWorkAttempts: vi.fn().mockResolvedValue([]),
        createWorkAttempt,
        listStagedWorkOrders,
      },
    } as never);

    await service.reconcileStagedOrgWork();

    expect(createWorkAttempt).toHaveBeenCalledTimes(51);
    expect(activate).toHaveBeenCalledTimes(51);
    expect(listStaged).toHaveBeenCalledTimes(2);
    expect(listStagedWorkOrders).toHaveBeenCalledOnce();
  });

  it('把超过宽限期且无 runtime run 的 queued WorkOrder 收口为 failed', async () => {
    const work = {
      workOrderId: 'orphan-work',
      tenantId: 'tenant-1',
      state: 'queued',
      currentAttemptNo: 0,
      version: 3,
    };
    const transitionWorkOrder = vi.fn().mockResolvedValue({ ...work, state: 'failed' });
    const service = new DurableBackgroundTaskService({
      runStore: {
        listStagedOrgAgentBackgroundTasks: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(null),
      },
      orgGroupAgentStore: {
        listStagedWorkOrders: vi.fn().mockResolvedValue([work]),
        listWorkAttempts: vi.fn().mockResolvedValue([]),
        transitionWorkAttempt: vi.fn().mockResolvedValue(null),
        getWorkOrder: vi.fn().mockResolvedValue(work),
        transitionWorkOrder,
      },
    } as never);

    await service.reconcileStagedOrgWork();

    expect(transitionWorkOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        workOrderId: 'orphan-work',
        expectedVersion: 3,
        state: 'failed',
      }),
    );
  });

  it('不会把仍有耐久 runtime run 的 queued WorkOrder 当作孤儿', async () => {
    const work = {
      workOrderId: 'live-work', tenantId: 'tenant-1', state: 'queued', currentAttemptNo: 1, version: 2,
    };
    const attempt = {
      workOrderId: 'live-work', attemptId: 'attempt-live', attemptNo: 1,
      runtimeRunId: 'run-live', mountSubPath: 'work/live/attempt-1', status: 'queued',
    };
    const transitionWorkOrder = vi.fn();
    const service = new DurableBackgroundTaskService({
      runStore: {
        listStagedOrgAgentBackgroundTasks: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(stagedRun(1)),
      },
      orgGroupAgentStore: {
        listStagedWorkOrders: vi.fn().mockResolvedValue([work]),
        listWorkAttempts: vi.fn().mockResolvedValue([attempt]),
        transitionWorkOrder,
      },
    } as never);

    await service.reconcileStagedOrgWork();
    expect(transitionWorkOrder).not.toHaveBeenCalled();
  });

  it('不会复活已经失败的 WorkOrder，也不会让旧 attempt 失败覆盖当前 attempt', async () => {
    const run = stagedRun(9) as any;
    const currentWork = {
      workOrderId: 'work-9', tenantId: 'tenant-1', state: 'running', currentAttemptNo: 2, version: 8,
    };
    const transitionWorkOrder = vi.fn();
    const markStatusIfCurrent = vi.fn().mockResolvedValue({ ...run, status: 'failed' });
    const activate = vi.fn();
    const service = new DurableBackgroundTaskService({
      runStore: {
        listStagedOrgAgentBackgroundTasks: vi.fn().mockResolvedValue([run]),
        activateStagedOrgAgentBackgroundTask: activate,
        markStatusIfCurrent,
        get: vi.fn(),
      },
      orgGroupAgentStore: {
        getWorkOrder: vi.fn().mockResolvedValue(currentWork),
        listWorkAttempts: vi.fn().mockResolvedValue([{ ...run.metadata, workOrderId: 'work-9',
          runtimeRunId: 'run-9', attemptNo: 1, status: 'queued' }]),
        transitionWorkAttempt: vi.fn().mockResolvedValue({ attemptNo: 1, status: 'failed' }),
        transitionWorkOrder,
        listStagedWorkOrders: vi.fn().mockResolvedValue([]),
      },
    } as never);

    await service.reconcileStagedOrgWork();

    expect(activate).not.toHaveBeenCalled();
    expect(markStatusIfCurrent).toHaveBeenCalledOnce();
    expect(transitionWorkOrder).not.toHaveBeenCalled();
  });
});
