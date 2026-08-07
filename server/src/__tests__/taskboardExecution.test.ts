import { describe, expect, it, vi } from 'vitest';

import type {
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
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

function makeRig(overrides: Partial<TaskboardExecutionStore> = {}) {
  const store = {
    listExecutions: vi.fn(async () => []),
    claimExecution: vi.fn(async (_identity, _taskId, input) => ({
      task: { ...task, status: 'in_progress' as const, version: task.version + 1 },
      execution: execution({ id: input.executionId, runId: input.runId, sessionId: input.sessionId }),
    })),
    getExecutionContextByRunId: vi.fn(async (runId: string): Promise<TaskboardExecutionContext | null> => ({
      identity,
      task,
      comments: [comment],
      execution: execution({ runId }),
    })),
    setExecutionStatus: vi.fn(async () => execution({ status: 'running' })),
    completeExecution: vi.fn(async () => ({ task, execution: execution({ status: 'succeeded' }) })),
    ...overrides,
  } as TaskboardExecutionStore;
  const scheduler = { enqueue: vi.fn(async (input) => ({ ...input, status: 'pending' })) };
  const sessionCatalog = {
    upsert: vi.fn(async () => undefined),
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
    sessionCatalog,
    eventStore,
    agentCwd: '/agent-workspaces',
    executionConfig: createExecutionConfig({ tenantDefaultTarget: 'server-remote' }),
    resolveDefaultModel: () => ({ ref: 'model-default' }),
  });
  return { coordinator, store, scheduler, sessionCatalog, eventStore };
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
    expect(rig.sessionCatalog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      userId: identity.ownerUserId,
      tenantId: identity.tenantId,
      modelRef: 'model-default',
      executionTarget: 'server-remote',
      workspaceId: `ws_${identity.tenantId}__${identity.ownerUserId}`,
    }));
    expect(rig.scheduler.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'taskboard',
      userId: identity.ownerUserId,
      tenantId: identity.tenantId,
      metadata: expect.objectContaining({ taskboardExecution: true }),
    }));
  });

  it('wake 前重读最新任务和评论并生成执行提示词', async () => {
    const rig = makeRig();
    const prepared = await rig.coordinator.prepareWake({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: { taskboardExecution: true },
    });

    expect(rig.store.getExecutionContextByRunId).toHaveBeenCalledWith('run-1');
    expect(rig.store.setExecutionStatus).toHaveBeenCalledWith('run-1', 'running');
    expect(prepared.metadata.wakeMessage).toMatchObject({
      content: expect.stringContaining(task.title),
    });
    expect((prepared.metadata.wakeMessage as { content: string }).content).toContain(comment.body);
  });

  it('wake 竞争到终态后立即停止，不再启动 Agent', async () => {
    const rig = makeRig({ setExecutionStatus: vi.fn(async () => null) });

    await expect(rig.coordinator.prepareWake({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: { taskboardExecution: true },
    })).rejects.toThrow('任务看板执行已终止');
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

  it('入队失败时把认领任务回写为失败，避免静默停在进行中', async () => {
    const completeExecution = vi.fn(async () => ({
      task: { ...task, status: 'blocked' as const },
      execution: execution({ status: 'failed' }),
    }));
    const rig = makeRig({ completeExecution });
    rig.scheduler.enqueue.mockRejectedValueOnce(new Error('scheduler unavailable'));

    await expect(rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version }))
      .rejects.toThrow('scheduler unavailable');
    expect(completeExecution).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'failed',
      error: 'scheduler unavailable',
    }));
  });
});
