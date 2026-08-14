import { describe, expect, it, vi } from 'vitest';

import type {
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore } from '../runtime/types.js';
import { completeContinuation } from '../taskboard/continuationStore.js';
import { TaskboardExecutionCoordinator } from '../taskboard/executionService.js';
import type {
  TaskboardExecutionStore,
  TaskboardIdentity,
} from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-1',
  ownerUserId: 'user-1',
  username: 'alice',
  userRole: 'user',
};

const task: TaskBoardTask = {
  id: 'task-1',
  boardId: 'board-1',
  identifier: 'TASK-1',
  title: '复用任务会话',
  description: '继续执行评论',
  status: 'in_progress',
  priority: 'high',
  labels: [],
  sortOrder: 1024,
  commentCount: 2,
  version: 4,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const comments: TaskBoardComment[] = [
  comment('comment-1', '先补充验收条件', '2026-08-01T01:00:00.000Z'),
  comment('comment-2', '再修复并发问题', '2026-08-01T01:01:00.000Z'),
];

const activeExecution: TaskBoardExecution = {
  id: 'execution-1',
  taskId: task.id,
  runId: 'execution-run-1',
  sessionId: 'taskboard-session-1',
  status: 'running',
  purpose: 'work',
  requestedBy: identity.ownerUserId,
  createdAt: '2026-08-01T00:30:00.000Z',
  updatedAt: '2026-08-01T00:30:00.000Z',
};

describe('任务看板评论续跑', () => {
  it('运行中评论复用同一 session，并将多条评论合并为 steering 输入', async () => {
    const rig = makeRig();

    const result = await rig.coordinator.continueExecution(identity, task.id, comments[1]!.id);

    expect(result.execution).toEqual(activeExecution);
    expect(rig.store.enqueueContinuation).toHaveBeenCalledWith(
      task.id,
      comments.map((item) => item.id),
      `taskboard-comment-${comments[1]!.id}`,
      comments[1]!.id,
      expect.objectContaining({
        version: 1,
        run: expect.objectContaining({
          runId: `taskboard-comment-${comments[1]!.id}`,
          sessionId: activeExecution.sessionId,
          idempotencyKey: `taskboard-comment:${comments[1]!.id}`,
          metadata: expect.objectContaining({
            wakeMessage: expect.objectContaining({
              content: expect.stringMatching(/先补充验收条件[\s\S]*再修复并发问题/),
            }),
          }),
        }),
      }),
    );
  });

  it('评论续跑先写持久化 outbox，再由派发器创建 Runtime Run', async () => {
    let durablePayload: Parameters<TaskboardExecutionStore['enqueueContinuation']>[4] | undefined;
    const rig = makeRig({
      enqueueContinuation: vi.fn(async (_taskId, _commentIds, _runId, _commentId, payload) => {
        durablePayload = payload;
        return true;
      }),
      claimContinuationDispatch: vi.fn(async (runId, leaseId) => durablePayload ? ({
        runId: runId!,
        taskId: task.id,
        commentId: comments[1]!.id,
        sessionId: durablePayload.session.sessionId,
        tenantId: identity.tenantId,
        ownerUserId: identity.ownerUserId,
        payload: durablePayload,
        attemptCount: 1,
        leaseId,
      }) : null),
    });

    await rig.coordinator.continueExecution(identity, task.id, comments[1]!.id);

    expect(rig.scheduler.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      runId: `taskboard-comment-${comments[1]!.id}`,
      sessionId: activeExecution.sessionId,
    }), { steeringAware: true });
    expect(rig.store.markContinuationDispatchSucceeded).toHaveBeenCalledWith(
      `taskboard-comment-${comments[1]!.id}`,
      expect.any(String),
    );
  });

  it('评论已绑定正式 Execution run 时，重复请求直接返回且不污染 run metadata', async () => {
    const rig = makeRig({
      getContinuationContext: vi.fn(async () => ({
        task,
        comment: comments[1]!,
        pendingComments: comments,
        continuationRunId: activeExecution.runId,
        activeExecution,
        latestExecution: activeExecution,
      })),
    });

    const result = await rig.coordinator.continueExecution(identity, task.id, comments[1]!.id);

    expect(result.execution).toEqual(activeExecution);
    expect(rig.runStore.get).not.toHaveBeenCalled();
    expect(rig.scheduler.enqueue).not.toHaveBeenCalled();
    expect(rig.store.enqueueContinuation).not.toHaveBeenCalled();
  });

  it('steering source 终态不提前写任务回执', async () => {
    const steeringRun = {
      runId: `taskboard-comment-${comments[1]!.id}`,
      sessionId: activeExecution.sessionId,
      status: 'completed' as const,
      requestedAt: '2026-08-01T01:02:00.000Z',
      updatedAt: '2026-08-01T01:03:00.000Z',
      metadata: {
        taskboardContinuation: true,
        taskboardTaskId: task.id,
        steeringTargetRunId: activeExecution.runId,
      },
    };
    const rig = makeRig({
      getContinuationContext: vi.fn(async () => ({
        task,
        comment: comments[1]!,
        pendingComments: comments,
        continuationRunId: steeringRun.runId,
        activeExecution,
        latestExecution: activeExecution,
      })),
      completeContinuation: vi.fn(async () => task),
    });
    rig.runStore.get.mockResolvedValue(steeringRun);

    await rig.coordinator.continueExecution(identity, task.id, comments[1]!.id);

    expect(rig.store.completeContinuation).not.toHaveBeenCalled();
  });

  it('重复请求遇到终态续跑 Run 时补写遗漏的任务回执', async () => {
    const terminalRun = {
      runId: `taskboard-comment-${comments[1]!.id}`,
      sessionId: activeExecution.sessionId,
      status: 'completed' as const,
      requestedAt: '2026-08-01T01:02:00.000Z',
      updatedAt: '2026-08-01T01:03:00.000Z',
      metadata: { taskboardContinuation: true, taskboardTaskId: task.id },
    };
    const rig = makeRig({
      getContinuationContext: vi.fn(async () => ({
        task,
        comment: comments[1]!,
        pendingComments: comments,
        continuationRunId: terminalRun.runId,
        latestExecution: activeExecution,
      })),
      completeContinuation: vi.fn(async () => ({ ...task, status: 'in_review' as const })),
    });
    rig.runStore.get.mockResolvedValue(terminalRun);

    const result = await rig.coordinator.continueExecution(identity, task.id, comments[1]!.id);

    expect(result.task.status).toBe('in_review');
    expect(rig.store.completeContinuation).toHaveBeenCalledWith(task.id, terminalRun.runId, expect.objectContaining({
      status: 'succeeded',
    }));
    expect(rig.scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('原 Execution 等待用户时仍持久化续跑回执，但不抢先移动任务状态', async () => {
    const sql: string[] = [];
    const taskRow = {
      id: task.id,
      board_id: task.boardId,
      identifier: task.identifier,
      title: task.title,
      description: task.description,
      status: 'in_progress',
      priority: task.priority,
      labels: [],
      sort_order: task.sortOrder,
      comment_count: task.commentCount,
      version: task.version,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      board_archived_at: null,
    };
    const client = {
      query: vi.fn(async (statement: string) => {
        sql.push(statement);
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [] };
        if (statement.includes('SELECT t.board_id, b.tenant_id')) {
          return { rows: [{ board_id: task.boardId, tenant_id: identity.tenantId, owner_user_id: identity.ownerUserId }] };
        }
        if (statement.includes('SELECT t.*, b.archived_at')) return { rows: [taskRow] };
        if (statement.includes("author_type IN ('agent', 'system')")) return { rows: [] };
        if (statement.includes('continuation_run_id=$2')) return { rows: [{ id: comments[1]!.id }] };
        if (statement.includes("status IN ('queued', 'running', 'waiting_user', 'waiting_approval')")) {
          return { rows: [{ id: activeExecution.id }] };
        }
        if (statement.includes('SELECT t.*')) return { rows: [taskRow] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const host = {
      pool: { connect: vi.fn(async () => client) },
      boardsTable: 'boards',
      tasksTable: 'tasks',
      commentsTable: 'comments',
      executionsTable: 'executions',
      continuationOutboxTable: 'continuation_outbox',
    } as never;

    const result = await completeContinuation(host, task.id, 'continuation-run', {
      status: 'succeeded',
      commentBody: 'Agent 交付\n\n等待态续跑结果',
    });

    expect(result?.status).toBe('in_progress');
    expect(sql.some((statement) => statement.includes('INSERT INTO comments'))).toBe(true);
    expect(sql.some((statement) => statement.includes("SET status='completed'"))).toBe(true);
    expect(sql.some((statement) => statement.includes('UPDATE tasks') && statement.includes('status=$2'))).toBe(false);
  });

  it('自动对账补写遗漏的评论续跑终态回执', async () => {
    const runId = `taskboard-comment-${comments[1]!.id}`;
    const rig = makeRig({
      claimContinuationReconcileCandidates: vi.fn(async () => [{
        runId,
        taskId: task.id,
        sessionId: activeExecution.sessionId,
        leaseId: 'continuation-reconcile-lease',
      }]),
      completeContinuation: vi.fn(async () => ({ ...task, status: 'in_review' as const })),
    });
    rig.runStore.get.mockResolvedValue({
      runId,
      sessionId: activeExecution.sessionId,
      status: 'completed',
      requestedAt: '2026-08-01T01:02:00.000Z',
      updatedAt: '2026-08-01T01:03:00.000Z',
      completedAt: '2026-08-01T01:03:00.000Z',
      metadata: { taskboardContinuation: true, taskboardTaskId: task.id },
    });
    vi.mocked(rig.eventStore.listByRun!).mockResolvedValue([{
      id: 'event-continuation-result',
      timestamp: '2026-08-01T01:03:00.000Z',
      type: 'assistant_message',
      runId,
      sessionId: activeExecution.sessionId,
      content: '等待态后的续跑交付',
    } as never]);

    await rig.coordinator.reconcile();

    expect(rig.store.completeContinuation).toHaveBeenCalledWith(task.id, runId, {
      status: 'succeeded',
      commentBody: 'Agent 交付\n\n等待态后的续跑交付',
    });
  });

  it('后续正式执行复用任务上一条 session，但生成新的 execution run', async () => {
    const completed = { ...activeExecution, status: 'succeeded' as const };
    const rig = makeRig({
      listExecutions: vi.fn(async () => [completed]),
      claimExecution: vi.fn(async (_identity, _taskId, input) => ({
        task: { ...task, version: task.version + 1 },
        execution: {
          ...activeExecution,
          id: input.executionId,
          runId: input.runId,
          sessionId: input.sessionId,
          status: 'queued' as const,
        },
      })),
    });

    await rig.coordinator.startDirectExecution(identity, task.id, task.version);

    expect(rig.store.claimExecution).toHaveBeenCalledWith(identity, task.id, expect.objectContaining({
      sessionId: completed.sessionId,
      runId: expect.not.stringMatching(/^execution-run-1$/),
      allowWorkFromCurrentStatus: true,
    }));
  });
});

function makeRig(overrides: Partial<TaskboardExecutionStore> = {}) {
  const store = {
    listExecutions: vi.fn(async () => [activeExecution]),
    getExecutionModelContext: vi.fn(async () => ({ boardOwnerUserId: identity.ownerUserId })),
    getContinuationContext: vi.fn(async () => ({
      task,
      comment: comments[1]!,
      pendingComments: comments,
      activeExecution,
      latestExecution: activeExecution,
    })),
    enqueueContinuation: vi.fn(async () => true),
    claimContinuationDispatch: vi.fn(async () => null),
    markContinuationDispatchSucceeded: vi.fn(async () => true),
    retryContinuationDispatch: vi.fn(async () => true),
    claimContinuationReconcileCandidates: vi.fn(async () => []),
    releaseContinuationReconcile: vi.fn(async () => true),
    finishContinuation: vi.fn(async () => true),
    markContinuationRunning: vi.fn(async () => task),
    claimExecution: vi.fn(),
    claimExecutionDispatch: vi.fn(async () => null),
    claimExecutionReconcileCandidates: vi.fn(async () => []),
    ...overrides,
  } as unknown as TaskboardExecutionStore;
  const scheduler = {
    enqueue: vi.fn(async (input): Promise<RunRecord> => ({
      ...input,
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: input.metadata ?? {},
    })),
    enqueueCreateOnly: vi.fn(),
  };
  const runStore = { get: vi.fn(async (): Promise<RunRecord | null> => null) };
  const sessionCatalog = {
    get: vi.fn(async () => ({
      sessionId: activeExecution.sessionId,
      userId: identity.ownerUserId,
      username: identity.username,
      userRole: identity.userRole,
      tenantId: identity.tenantId,
      channel: 'web',
      cwd: '/agent/tenant-1/user-1',
      transcriptPath: '/agent/tenant-1/user-1/transcript.jsonl',
      workspaceId: 'ws_tenant-1__user-1',
      status: 'running' as const,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })),
    upsert: vi.fn(async () => undefined),
    ensure: vi.fn(async () => undefined),
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
    scheduler,
    runStore,
    sessionCatalog,
    eventStore,
    agentCwd: '/agent',
    executionConfig: createExecutionConfig({ tenantDefaultTarget: 'server-remote' }),
    resolveDefaultModel: () => ({ ref: 'model-default' }),
  });
  return { coordinator, store, scheduler, runStore, sessionCatalog, eventStore };
}

function comment(id: string, body: string, createdAt: string): TaskBoardComment {
  return {
    id,
    taskId: task.id,
    body,
    authorType: 'user',
    authorId: identity.ownerUserId,
    authorName: identity.username,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}
