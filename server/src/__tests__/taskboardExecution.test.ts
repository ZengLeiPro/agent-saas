import { describe, expect, it, vi } from 'vitest';

import type {
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import { RunCreateConflictError, type RunRecord } from '../runtime/runStore.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import { TaskboardExecutionCoordinator } from '../taskboard/executionService.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionStore,
  TaskboardIdentity,
} from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a',
  ownerUserId: 'user-1',
  username: 'alice',
  userRole: 'user',
};

const task: TaskBoardTask = {
  id: 'task-1',
  boardId: 'board-1',
  identifier: 'TASK-1',
  title: '实现执行闭环',
  description: '使用最新任务内容',
  status: 'todo',
  priority: 'high',
  labels: ['agent'],
  sortOrder: 1024,
  commentCount: 1,
  version: 3,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const comment: TaskBoardComment = {
  id: 'comment-1',
  taskId: task.id,
  body: '以评论里的验收条件为准',
  authorType: 'user',
  authorId: identity.ownerUserId,
  authorName: identity.username,
  version: 1,
  createdAt: '2026-08-01T01:00:00.000Z',
  updatedAt: '2026-08-01T01:00:00.000Z',
};

function execution(input: Partial<TaskBoardExecution> = {}): TaskBoardExecution {
  return {
    id: 'execution-1',
    taskId: task.id,
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'queued',
    requestedBy: identity.ownerUserId,
    createdAt: '2026-08-01T02:00:00.000Z',
    updatedAt: '2026-08-01T02:00:00.000Z',
    ...input,
  };
}

function makeRig(
  overrides: Partial<TaskboardExecutionStore> = {},
  coordinatorOptions: Partial<ConstructorParameters<typeof TaskboardExecutionCoordinator>[0]> = {},
) {
  const dispatches = new Map<string, {
    executionId: string;
    payload: Parameters<TaskboardExecutionStore['claimExecution']>[2]['dispatch'];
  }>();
  const store = {
    listExecutions: vi.fn(async () => []),
    getExecutionModelContext: vi.fn(async () => ({ boardOwnerUserId: identity.ownerUserId })),
    claimExecution: vi.fn(async (_identity, _taskId, input) => {
      dispatches.set(input.runId, { executionId: input.executionId, payload: input.dispatch });
      return {
        task: { ...task, status: 'in_progress' as const, version: task.version + 1 },
        execution: execution({ id: input.executionId, runId: input.runId, sessionId: input.sessionId }),
      };
    }),
    getExecutionContextByRunId: vi.fn(async (runId: string): Promise<TaskboardExecutionContext | null> => ({
      identity,
      task,
      boardPrompt: '只修改与任务直接相关的文件。',
      comments: [comment],
      execution: execution({ runId }),
    })),
    claimExecutionDispatch: vi.fn(async (runId: string | undefined, leaseId: string) => {
      let claimedRunId: string;
      let dispatch: { executionId: string; payload: Parameters<TaskboardExecutionStore['claimExecution']>[2]['dispatch'] };
      if (runId) {
        const exact = dispatches.get(runId);
        if (!exact) return null;
        claimedRunId = runId;
        dispatch = exact;
      } else {
        const next = dispatches.entries().next();
        if (next.done) return null;
        [claimedRunId, dispatch] = next.value;
      }
      return {
        runId: claimedRunId,
        executionId: dispatch.executionId,
        outboxExecutionId: dispatch.executionId,
        taskId: task.id,
        sessionId: dispatch.payload.session.sessionId,
        tenantId: identity.tenantId,
        ownerUserId: identity.ownerUserId,
        payload: dispatch.payload,
        attemptCount: 1,
        leaseId,
      };
    }),
    markExecutionDispatchSucceeded: vi.fn(async (runId: string) => {
      dispatches.delete(runId);
      return true;
    }),
    retryExecutionDispatch: vi.fn(async () => true),
    claimExecutionReconcileCandidates: vi.fn(async () => []),
    setExecutionStatus: vi.fn(async () => execution({ status: 'running' })),
    setExecutionStatusFromReconcile: vi.fn(async () => execution({ status: 'running' })),
    completeExecution: vi.fn(async () => ({ task, execution: execution({ status: 'succeeded' }) })),
    completeExecutionFromReconcile: vi.fn(async () => ({ task, execution: execution({ status: 'succeeded' }) })),
    ...overrides,
  } as TaskboardExecutionStore;
  const scheduler = {
    enqueueCreateOnly: vi.fn(async (input) => ({
      ...input,
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: input.metadata ?? {},
    })),
  };
  const runStore = { get: vi.fn(async (): Promise<RunRecord | null> => null) };
  const sessionCatalog = {
    upsert: vi.fn(async () => undefined),
    ensure: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    markStatus: vi.fn(async () => undefined),
    findTranscriptPath: vi.fn(async () => null),
  } satisfies SessionCatalog;
  const eventStore = {
    append: vi.fn(),
    list: vi.fn(async () => []),
    listByRun: vi.fn(async () => []),
  } as unknown as EventStore;
  const coordinator = new TaskboardExecutionCoordinator({
    store,
    scheduler: scheduler as never,
    runStore,
    sessionCatalog,
    eventStore,
    agentCwd: '/agent-workspaces',
    executionConfig: createExecutionConfig({ tenantDefaultTarget: 'server-remote' }),
    resolveDefaultModel: () => ({ ref: 'model-default' }),
    ...coordinatorOptions,
  });
  return { coordinator, store, scheduler, runStore, sessionCatalog, eventStore };
}

describe('TaskboardExecutionCoordinator', () => {
  it('先原子认领，再创建独立会话并进入 durable scheduler', async () => {
    const rig = makeRig();
    const result = await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

    expect(result.task.status).toBe('in_progress');
    expect(rig.store.claimExecution).toHaveBeenCalledWith(identity, task.id, expect.objectContaining({
      expectedVersion: task.version,
      executionId: expect.any(String),
      runId: expect.any(String),
      sessionId: expect.any(String),
    }));
    expect(rig.sessionCatalog.ensure).toHaveBeenCalledWith(expect.objectContaining({
      userId: identity.ownerUserId,
      tenantId: identity.tenantId,
      modelRef: 'model-default',
      executionTarget: 'server-remote',
      workspaceId: `ws_${identity.tenantId}__${identity.ownerUserId}`,
    }));
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'taskboard',
      userId: identity.ownerUserId,
      tenantId: identity.tenantId,
      metadata: expect.objectContaining({ taskboardExecution: true }),
    }));
  });

  it('组织成员发起任务时仍以看板创建者上下文运行', async () => {
    const member: TaskboardIdentity = {
      tenantId: identity.tenantId,
      ownerUserId: 'user-2',
      username: 'bob',
      userRole: 'user',
    };
    const resolveOwnerIdentity = vi.fn(() => identity);
    const rig = makeRig({
      getExecutionModelContext: vi.fn(async () => ({ boardOwnerUserId: identity.ownerUserId })),
    }, { resolveOwnerIdentity });

    await rig.coordinator.startExecution(member, task.id, { expectedVersion: task.version });

    expect(resolveOwnerIdentity).toHaveBeenCalledWith(identity.ownerUserId);
    expect(rig.store.claimExecution).toHaveBeenCalledWith(
      member,
      task.id,
      expect.objectContaining({ executionOwnerUserId: identity.ownerUserId }),
    );
    expect(rig.sessionCatalog.ensure).toHaveBeenCalledWith(expect.objectContaining({
      userId: identity.ownerUserId,
      username: identity.username,
      workspaceId: `ws_${identity.tenantId}__${identity.ownerUserId}`,
    }));
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledWith(expect.objectContaining({
      userId: identity.ownerUserId,
      tenantId: identity.tenantId,
    }));
  });

  it('组织看板创建者账号不可用时拒绝使用发起者上下文兜底', async () => {
    const member: TaskboardIdentity = {
      tenantId: identity.tenantId,
      ownerUserId: 'user-2',
      username: 'bob',
      userRole: 'user',
    };
    const rig = makeRig({
      getExecutionModelContext: vi.fn(async () => ({ boardOwnerUserId: identity.ownerUserId })),
    });

    await expect(rig.coordinator.startExecution(
      member,
      task.id,
      { expectedVersion: task.version },
    )).rejects.toThrow('看板创建者账号不可用');
    expect(rig.store.claimExecution).not.toHaveBeenCalled();
    expect(rig.sessionCatalog.ensure).not.toHaveBeenCalled();
  });

  it('wake 前重读最新任务和评论并生成执行提示词', async () => {
    const rig = makeRig({}, {
      resolveUserDisplayName: () => '爱丽丝 @alice',
      timezone: 'Asia/Shanghai',
    });
    const prepared = await rig.coordinator.prepareWake({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    });

    expect(rig.store.getExecutionContextByRunId).toHaveBeenCalledWith('run-1');
    expect(rig.store.setExecutionStatus).toHaveBeenCalledWith('run-1', 'running');
    expect(prepared.metadata.wakeMessage).toMatchObject({
      content: expect.stringContaining(task.title),
    });
    const content = (prepared.metadata.wakeMessage as { content: string }).content;
    expect(content.startsWith('看板提示语：\n只修改与任务直接相关的文件。')).toBe(true);
    expect(content).toContain(comment.body);
    expect(content).not.toContain('1. 直接完成任务，必要时使用可用工具；不要只给计划。');
    expect(content).not.toContain('你正在执行一条由用户明确交给 Agent 的任务看板任务。');
    expect(content).not.toContain('执行前输入已从服务端重新读取');
    // 评论时间戳使用与正常会话用户消息一致的格式（Asia/Shanghai）
    expect(content).toContain('[2026/08/01 周六 09:00] 爱丽丝 @alice（user）');
    expect(content).not.toContain('2026-08-01T01:00:00.000Z');
  });

  it('wake 时显式模型已被组织禁用则拒绝启动', async () => {
    const resolveModel = vi.fn(() => null);
    const rig = makeRig({}, { resolveModel });

    await expect(rig.coordinator.prepareWake({
      runId: 'run-1',
      sessionId: 'session-1',
      model: 'group-a/model-disabled',
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    })).rejects.toThrow('指定模型不可用：group-a/model-disabled');
    expect(resolveModel).toHaveBeenCalledWith('group-a/model-disabled', identity.tenantId);
    expect(rig.store.setExecutionStatus).not.toHaveBeenCalled();
  });

  it('wake 竞争到终态后立即停止，不再启动 Agent', async () => {
    const rig = makeRig({ setExecutionStatus: vi.fn(async () => null) });

    await expect(rig.coordinator.prepareWake({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    })).rejects.toThrow('任务看板执行已终止');
  });

  it('任务级模型优先于看板模型，看板模型优先于组织默认模型', async () => {
    const resolveModel = vi.fn((ref: string) => ({ ref }));
    const rig = makeRig(
      {
        getExecutionModelContext: vi.fn(async () => ({
          taskModel: 'group-a/model-task',
          boardModel: 'group-a/model-board',
          boardOwnerUserId: identity.ownerUserId,
        })),
      },
      { resolveModel },
    );
    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    expect(rig.store.claimExecution).toHaveBeenCalledWith(
      identity,
      task.id,
      expect.objectContaining({ configuredModelRef: 'group-a/model-task' }),
    );
    expect(rig.sessionCatalog.ensure).toHaveBeenCalledWith(expect.objectContaining({
      modelRef: 'group-a/model-task',
    }));

    const boardOnlyRig = makeRig(
      {
        getExecutionModelContext: vi.fn(async () => ({
          boardModel: 'group-a/model-board',
          boardOwnerUserId: identity.ownerUserId,
        })),
      },
      { resolveModel },
    );
    await boardOnlyRig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    expect(boardOnlyRig.sessionCatalog.ensure).toHaveBeenCalledWith(expect.objectContaining({
      modelRef: 'group-a/model-board',
    }));
  });

  it('未指定模型时使用组织默认，显式模型不可用时拒绝执行', async () => {
    const defaultRig = makeRig();
    await defaultRig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    expect(defaultRig.sessionCatalog.ensure).toHaveBeenCalledWith(expect.objectContaining({
      modelRef: 'model-default',
    }));

    const withoutResolver = makeRig({
      getExecutionModelContext: vi.fn(async () => ({
          boardModel: 'group-a/model-board',
          boardOwnerUserId: identity.ownerUserId,
        })),
    });
    await expect(withoutResolver.coordinator.startExecution(
      identity,
      task.id,
      { expectedVersion: task.version },
    )).rejects.toThrow('指定模型不可用：group-a/model-board');

    const resolveModel = vi.fn(() => null);
    const rejectedRig = makeRig(
      {
        getExecutionModelContext: vi.fn(async () => ({
          boardModel: 'group-a/model-board',
          boardOwnerUserId: identity.ownerUserId,
        })),
      },
      { resolveModel },
    );
    await expect(rejectedRig.coordinator.startExecution(
      identity,
      task.id,
      { expectedVersion: task.version },
    )).rejects.toThrow('指定模型不可用：group-a/model-board');
    expect(resolveModel).toHaveBeenCalledWith('group-a/model-board', identity.tenantId);
    expect(rejectedRig.sessionCatalog.ensure).not.toHaveBeenCalled();
  });

  it('成功终态提取最终 assistant_message 作为待复核交付回执', async () => {
    const completeExecution = vi.fn(async () => ({
      task: { ...task, status: 'in_review' as const },
      execution: execution({ status: 'succeeded' }),
    }));
    const rig = makeRig({ completeExecution });
    vi.mocked(rig.eventStore.listByRun!).mockResolvedValue([
      {
        id: 'event-1',
        timestamp: '2026-08-01T03:00:00.000Z',
        type: 'assistant_message',
        runId: 'run-1',
        sessionId: 'session-1',
        content: '已实现并完成自验',
      } as PlatformEvent,
      {
        id: 'event-foreign',
        timestamp: '2026-08-01T03:00:30.000Z',
        type: 'assistant_message',
        runId: 'run-1',
        sessionId: 'other-session',
        content: '不应串入的交付',
      } as PlatformEvent,
    ]);

    await rig.coordinator.handleRuntimeEvent({
      id: 'event-2',
      timestamp: '2026-08-01T03:01:00.000Z',
      type: 'run_finished',
      runId: 'run-1',
      sessionId: 'session-1',
      subtype: 'success',
      numTurns: 2,
    } as PlatformEvent);

    expect(completeExecution).toHaveBeenCalledWith('run-1', {
      status: 'succeeded',
      commentBody: 'Agent 交付\n\n已实现并完成自验',
    });
  });

  it('入队失败时保留 queued 执行并登记 outbox 重试，不提前写失败终态', async () => {
    const rig = makeRig();
    rig.scheduler.enqueueCreateOnly.mockRejectedValueOnce(new Error('scheduler unavailable'));

    await expect(rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version }))
      .resolves.toMatchObject({ execution: { status: 'queued' } });
    expect(rig.store.retryExecutionDispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'Agent 派发重试中：scheduler unavailable',
      1_000,
    );
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
  });

  it('毒 outbox payload 会终止 Execution，不进入永久重试', async () => {
    const claimExecutionDispatch = vi.fn()
      .mockResolvedValueOnce({
        runId: 'poison-run',
        executionId: 'poison-execution',
        payload: { version: 2 } as never,
        attemptCount: 1,
        leaseId: 'poison-lease',
      })
      .mockResolvedValue(null);
    const rig = makeRig({ claimExecutionDispatch });

    await rig.coordinator.reconcile();

    expect(rig.scheduler.enqueueCreateOnly).not.toHaveBeenCalled();
    expect(rig.store.completeExecution).toHaveBeenCalledWith('poison-run', expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('payload'),
    }));
    expect(rig.store.retryExecutionDispatch).not.toHaveBeenCalled();
  });

  it('合法外形 payload 的特权扩展字段不会进入 Session 或 Runtime Run', async () => {
    const seed = makeRig();
    await seed.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });
    const claimedInput = vi.mocked(seed.store.claimExecution).mock.calls[0]![2];
    const poisonedPayload = {
      ...claimedInput.dispatch,
      session: {
        ...claimedInput.dispatch.session,
        kind: 'subagent',
        orgAgentId: 'forged-org-agent',
        profileId: 'forged-profile',
      },
      run: {
        ...claimedInput.dispatch.run,
        sandboxScopeId: 'forged-sandbox',
        metadata: {
          ...claimedInput.dispatch.run.metadata,
          backgroundTask: true,
          toolProfile: 'forged-tool-profile',
          approvalPolicy: 'allow-all',
        },
      },
    } as never;
    const claimExecutionDispatch = vi.fn()
      .mockResolvedValueOnce({
        runId: claimedInput.runId,
        executionId: claimedInput.executionId,
        outboxExecutionId: claimedInput.executionId,
        taskId: task.id,
        sessionId: claimedInput.sessionId,
        tenantId: identity.tenantId,
        ownerUserId: identity.ownerUserId,
        payload: poisonedPayload,
        attemptCount: 1,
        leaseId: 'lease-canonical',
      })
      .mockResolvedValue(null);
    const rig = makeRig({ claimExecutionDispatch });

    await rig.coordinator.reconcile();

    expect(rig.sessionCatalog.ensure).toHaveBeenCalledWith(expect.not.objectContaining({
      kind: 'subagent',
      orgAgentId: 'forged-org-agent',
      profileId: 'forged-profile',
    }));
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledWith(expect.not.objectContaining({
      sandboxScopeId: 'forged-sandbox',
    }));
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({
        backgroundTask: true,
        toolProfile: 'forged-tool-profile',
        approvalPolicy: 'allow-all',
      }),
    }));
  });

  it('create-only 命中关联污染的既有 Run 时失败收口，不标记 dispatched', async () => {
    const rig = makeRig();
    rig.scheduler.enqueueCreateOnly.mockImplementationOnce(async (input) => ({
      ...input,
      status: 'waiting_user',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      metadata: { ...input.metadata, taskboardTaskId: 'other-task' },
    }));

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

    expect(rig.store.completeExecution).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('既有 Runtime Run'),
    }));
    expect(rig.store.markExecutionDispatchSucceeded).not.toHaveBeenCalled();
  });

  it('create-only 幂等键永久冲突会失败收口，不进入瞬时重试', async () => {
    const rig = makeRig();
    rig.scheduler.enqueueCreateOnly.mockRejectedValueOnce(
      new RunCreateConflictError('Run create-only idempotency conflict'),
    );

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version });

    expect(rig.store.completeExecution).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('idempotency conflict'),
    }));
    expect(rig.store.retryExecutionDispatch).not.toHaveBeenCalled();
  });

  it('后台对账使用 single-flight，不阻塞或叠加 Scheduler tick', async () => {
    let resolveCandidates!: (value: []) => void;
    const candidates = new Promise<[]>((resolve) => { resolveCandidates = resolve; });
    const rig = makeRig({
      claimExecutionReconcileCandidates: vi.fn(() => candidates),
    });

    rig.coordinator.wakeReconciliation();
    rig.coordinator.wakeReconciliation();
    await vi.waitFor(() => {
      expect(rig.store.claimExecutionReconcileCandidates).toHaveBeenCalledTimes(1);
    });
    resolveCandidates([]);
    await rig.coordinator.stop();

    expect(rig.store.claimExecutionReconcileCandidates).toHaveBeenCalledTimes(1);
  });

  it('Runtime 终态 session 不匹配时拒绝读取回执或完成 Execution', async () => {
    const rig = makeRig();

    await expect(rig.coordinator.handleRuntimeEvent({
      id: 'event-mismatch',
      timestamp: '2026-08-01T03:01:00.000Z',
      type: 'run_finished',
      runId: 'run-1',
      sessionId: 'other-session',
      subtype: 'success',
      numTurns: 2,
    } as PlatformEvent)).rejects.toThrow('session');

    expect(rig.eventStore.listByRun).not.toHaveBeenCalled();
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
  });

  it('定时对账会补写遗漏的 Runtime 成功终态', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'run-1',
      executionId: 'execution-1',
      sessionId: 'session-1',
      executionStatus: 'running',
      dispatchStatus: 'dispatched',
      leaseId: 'reconcile-lease',
    }]);
    rig.runStore.get.mockResolvedValue({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      completedAt: '2026-08-01T00:01:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    });
    vi.mocked(rig.eventStore.listByRun!).mockResolvedValue([{
      id: 'event-1',
      timestamp: '2026-08-01T00:01:00.000Z',
      type: 'assistant_message',
      runId: 'run-1',
      sessionId: 'session-1',
      content: '漏事件后的交付结果',
    } as PlatformEvent]);

    await rig.coordinator.reconcile();

    expect(rig.store.completeExecutionFromReconcile).toHaveBeenCalledWith('run-1', {
      status: 'succeeded',
      commentBody: 'Agent 交付\n\n漏事件后的交付结果',
    }, 'reconcile-lease');
  });

  it('对账发现 Run metadata 与 Execution 不匹配时按失败收口且不读取回执', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'run-1',
      executionId: 'execution-1',
      sessionId: 'session-1',
      executionStatus: 'running',
      dispatchStatus: 'dispatched',
      leaseId: 'reconcile-lease',
    }]);
    rig.runStore.get.mockResolvedValue({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      completedAt: '2026-08-01T00:01:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'other-execution' },
    });

    await rig.coordinator.reconcile();

    expect(rig.eventStore.listByRun).not.toHaveBeenCalled();
    expect(rig.store.completeExecutionFromReconcile).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'failed',
        error: 'Runtime Run 与任务看板 Execution 关联校验失败',
      }),
      'reconcile-lease',
    );
  });

  it('刚进入终态的 Run 保留 live 事件宽限期，不抢先写无文本回执', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'run-fresh',
      executionId: 'execution-1',
      sessionId: 'session-fresh',
      executionStatus: 'running',
      dispatchStatus: 'dispatched',
      leaseId: 'reconcile-lease',
    }]);
    rig.runStore.get.mockResolvedValue({
      runId: 'run-fresh',
      sessionId: 'session-fresh',
      status: 'completed',
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    });

    await rig.coordinator.reconcile();

    expect(rig.eventStore.listByRun).not.toHaveBeenCalled();
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
    expect(rig.store.completeExecutionFromReconcile).not.toHaveBeenCalled();
  });

  it('旧活跃执行同时缺少 outbox 与 Runtime Run 时自动阻塞，不再永久卡住', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'legacy-run',
      executionId: 'legacy-execution',
      sessionId: 'legacy-session',
      executionStatus: 'queued',
      leaseId: 'reconcile-lease',
    }]);

    await rig.coordinator.reconcile();

    expect(rig.store.completeExecutionFromReconcile).toHaveBeenCalledWith(
      'legacy-run',
      expect.objectContaining({
        status: 'failed',
        error: '执行派发记录缺失，已停止该次 Agent 执行',
      }),
      'reconcile-lease',
    );
  });
});
