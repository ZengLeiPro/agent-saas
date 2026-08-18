import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardExecutionPurpose,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore } from '../runtime/types.js';
import {
  completeContinuation,
  loadContinuationContext,
  markContinuationRunning,
} from '../taskboard/continuationStore.js';
import { TaskboardExecutionCoordinator } from '../taskboard/executionService.js';
import {
  TaskboardValidationError,
  type TaskboardExecutionModelContext,
  type TaskboardExecutionStore,
  type TaskboardIdentity,
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
              content: expect.stringMatching(/taskId: task-1[\s\S]*triggerCommentId: comment-2/),
            }),
          }),
        }),
      }),
    );
  });

  it('已有评论续跑占用 session 时，新评论继续走 steering 而不是新建 Execution', async () => {
    const latestExecution = { ...activeExecution, status: 'succeeded' as const };
    const rig = makeRig({
      getContinuationContext: vi.fn(async () => ({
        task,
        comment: comments[1]!,
        pendingComments: comments,
        hasActiveContinuation: true,
        latestExecution,
      })),
    });

    const result = await rig.coordinator.continueExecution(identity, task.id, comments[1]!.id);

    expect(result.execution).toEqual(latestExecution);
    expect(rig.store.claimExecution).not.toHaveBeenCalled();
    expect(rig.store.enqueueContinuation).toHaveBeenCalledOnce();
  });

  it('并发请求抢先创建 Execution 后，失败方重读上下文并幂等复用', async () => {
    const getContinuationContext = vi.fn()
      .mockResolvedValueOnce({ task, comment: comments[1]!, pendingComments: comments })
      .mockResolvedValueOnce({
        task,
        comment: comments[1]!,
        pendingComments: comments,
        continuationRunId: activeExecution.runId,
        activeExecution,
        latestExecution: activeExecution,
      });
    const rig = makeRig({
      getContinuationContext,
      claimExecution: vi.fn(async () => {
        throw new TaskboardValidationError('active', 'TASKBOARD_EXECUTION_ACTIVE');
      }),
    });

    const result = await rig.coordinator.continueExecution(identity, task.id, comments[1]!.id);

    expect(result.execution).toEqual(activeExecution);
    expect(getContinuationContext).toHaveBeenCalledTimes(2);
    expect(rig.store.enqueueContinuation).not.toHaveBeenCalled();
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

    expect(rig.writeSessionTitle).toHaveBeenCalledWith(expect.objectContaining({
      store: rig.store,
      sessionId: activeExecution.sessionId,
      transcriptPath: '/agent/tenant-1/user-1/transcript.jsonl',
    }));
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

  it('旧评论绑定非最新正式 Execution 时，重复请求仍直接返回原 Execution', async () => {
    const historicalExecution = { ...activeExecution, status: 'succeeded' as const };
    const latestExecution = {
      ...activeExecution,
      id: 'execution-2',
      runId: 'execution-run-2',
      status: 'succeeded' as const,
      createdAt: '2026-08-01T02:00:00.000Z',
      updatedAt: '2026-08-01T02:00:00.000Z',
    };
    const rig = makeRig({
      getContinuationContext: vi.fn(async () => ({
        task,
        comment: comments[1]!,
        pendingComments: comments,
        continuationRunId: historicalExecution.runId,
        continuationExecution: historicalExecution,
        latestExecution,
      })),
      completeContinuation: vi.fn(async () => task),
    });

    const result = await rig.coordinator.continueExecution(identity, task.id, comments[1]!.id);

    expect(result.execution).toEqual(historicalExecution);
    expect(rig.runStore.get).not.toHaveBeenCalled();
    expect(rig.store.completeContinuation).not.toHaveBeenCalled();
    expect(rig.scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('评论绑定超过最近 50 条的正式 Execution 时仍按 runId 精确命中', async () => {
    const historicalRunId = 'execution-run-historical';
    const taskRow = {
      id: task.id, board_id: task.boardId, identifier: task.identifier, title: task.title,
      description: task.description, status: task.status, priority: task.priority, labels: [],
      sort_order: task.sortOrder, comment_count: task.commentCount, version: task.version,
      created_at: task.createdAt, updated_at: task.updatedAt,
    };
    const commentRow = {
      id: comments[1]!.id, task_id: task.id, body: comments[1]!.body, attachments: [],
      author_type: 'user', author_id: identity.ownerUserId, author_name: identity.username,
      continuation_eligible: true, continuation_run_id: historicalRunId, version: 1,
      created_at: comments[1]!.createdAt, updated_at: comments[1]!.updatedAt,
    };
    const executionRow = (index: number, runId = `execution-run-${index}`) => ({
      id: `execution-${index}`, task_id: task.id, run_id: runId,
      session_id: activeExecution.sessionId, status: 'succeeded', purpose: 'work',
      requested_by: identity.ownerUserId,
      created_at: `2026-08-02T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      updated_at: `2026-08-02T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    });
    const pool = {
      query: vi.fn(async (statement: string) => {
        if (statement.includes('SELECT t.*') && statement.includes('comment_count')) return { rows: [taskRow] };
        if (statement.includes('WHERE c.id=$1')) return { rows: [commentRow] };
        if (statement.includes('e.run_id=$2')) return { rows: [executionRow(0, historicalRunId)] };
        if (statement.includes('ORDER BY e.created_at DESC')) {
          return { rows: Array.from({ length: 50 }, (_, index) => executionRow(index + 1)) };
        }
        if (statement.includes('c.created_at <= $2::timestamptz')) return { rows: [commentRow] };
        if (statement.includes('FROM continuation_outbox')) return { rows: [] };
        throw new Error(`未处理 SQL：${statement}`);
      }),
    };

    const context = await loadContinuationContext({
      pool, boardsTable: 'boards', tasksTable: 'tasks', commentsTable: 'comments',
      executionsTable: 'executions', continuationOutboxTable: 'continuation_outbox',
    } as never, identity, task.id, comments[1]!.id);

    expect(context.latestExecution?.runId).not.toBe(historicalRunId);
    expect(context.continuationExecution?.runId).toBe(historicalRunId);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('e.run_id=$2'),
      [task.id, historicalRunId, identity.tenantId, identity.ownerUserId],
    );
  });

  it('steering source 已应用终态不提前写任务回执', async () => {
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
        steeringState: 'applied',
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

  it('steering source 被取消后补写取消回执，不静默结清评论', async () => {
    const steeringRun = {
      runId: `taskboard-comment-${comments[1]!.id}`,
      sessionId: activeExecution.sessionId,
      status: 'cancelled' as const,
      statusReason: 'user_stopped',
      requestedAt: '2026-08-01T01:02:00.000Z',
      updatedAt: '2026-08-01T01:03:00.000Z',
      cancelledAt: '2026-08-01T01:03:00.000Z',
      metadata: {
        taskboardContinuation: true,
        taskboardTaskId: task.id,
        steeringTargetRunId: activeExecution.runId,
        steeringState: 'cancelled',
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

    expect(rig.store.completeContinuation).toHaveBeenCalledWith(task.id, steeringRun.runId, {
      status: 'cancelled',
      error: 'user_stopped',
      commentBody: 'Agent 继续执行已取消\n\nuser_stopped',
    });
    expect(rig.store.finishContinuation).not.toHaveBeenCalled();
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

  it('成功续跑可把原 Execution 先取消造成的 blocked 收敛到 in_review', async () => {
    const queries: Array<{ statement: string; params: unknown[] }> = [];
    const taskRow = {
      id: task.id, board_id: task.boardId, identifier: task.identifier, title: task.title,
      description: task.description, status: 'blocked', priority: task.priority, labels: [],
      sort_order: task.sortOrder, comment_count: task.commentCount, version: task.version,
      created_at: task.createdAt, updated_at: task.updatedAt, board_archived_at: null,
    };
    const client = {
      query: vi.fn(async (statement: string, params: unknown[] = []) => {
        queries.push({ statement, params });
        if (statement.includes('SELECT t.board_id, b.tenant_id')) {
          return { rows: [{ board_id: task.boardId, tenant_id: identity.tenantId, owner_user_id: identity.ownerUserId }] };
        }
        if (statement.includes('SELECT t.*, b.archived_at')) return { rows: [taskRow] };
        if (statement.includes("author_type IN ('agent', 'system')")) return { rows: [] };
        if (statement.includes('continuation_run_id=$2')) return { rows: [{ id: comments[1]!.id }] };
        if (statement.includes("status IN ('queued', 'running', 'waiting_user', 'waiting_approval')")) return { rows: [] };
        if (statement.includes('e.finished_at=t.updated_at')) return { rows: [{ '?column?': 1 }] };
        if (statement.includes('SELECT t.*')) return { rows: [taskRow] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    await completeContinuation({
      pool: { connect: vi.fn(async () => client) }, boardsTable: 'boards', tasksTable: 'tasks',
      commentsTable: 'comments', executionsTable: 'executions', continuationOutboxTable: 'continuation_outbox',
    } as never, task.id, 'continuation-after-cancel', {
      status: 'succeeded',
      commentBody: 'Agent 交付\n\n续跑成功',
    });

    const taskUpdate = queries.find(({ statement }) => (
      statement.includes('UPDATE tasks') && statement.includes('status=$2')
    ));
    expect(taskUpdate?.params[1]).toBe('in_review');
  });

  it('completeContinuation 遇到正式 Execution run 时只结清 outbox，不重复补写历史回执', async () => {
    const sql: string[] = [];
    const taskRow = {
      id: task.id, board_id: task.boardId, identifier: task.identifier, title: task.title,
      description: task.description, status: task.status, priority: task.priority, labels: [],
      sort_order: task.sortOrder, comment_count: task.commentCount, version: task.version,
      created_at: task.createdAt, updated_at: task.updatedAt, board_archived_at: null,
    };
    const client = {
      query: vi.fn(async (statement: string) => {
        sql.push(statement);
        if (statement.includes('SELECT t.board_id, b.tenant_id')) {
          return { rows: [{ board_id: task.boardId, tenant_id: identity.tenantId, owner_user_id: identity.ownerUserId }] };
        }
        if (statement.includes('SELECT t.*, b.archived_at')) return { rows: [taskRow] };
        if (statement.includes('SELECT id FROM executions')) return { rows: [{ id: activeExecution.id }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    await completeContinuation({
      pool: { connect: vi.fn(async () => client) }, boardsTable: 'boards', tasksTable: 'tasks',
      commentsTable: 'comments', executionsTable: 'executions', continuationOutboxTable: 'continuation_outbox',
    } as never, task.id, activeExecution.runId, {
      status: 'succeeded',
      commentBody: '不应重复写入',
    });

    expect(sql.some((statement) => statement.includes("SET status='completed'"))).toBe(true);
    expect(sql.some((statement) => statement.includes('INSERT INTO comments'))).toBe(false);
  });

  it('终态回执先完成时，过期 reconcile 不会把任务状态改回进行中', async () => {
    const sql: string[] = [];
    const taskRow = {
      id: task.id, board_id: task.boardId, identifier: task.identifier, title: task.title,
      description: task.description, status: 'in_review', priority: task.priority, labels: [],
      sort_order: task.sortOrder, comment_count: task.commentCount, version: task.version,
      created_at: task.createdAt, updated_at: task.updatedAt, board_archived_at: null,
    };
    const client = {
      query: vi.fn(async (statement: string) => {
        sql.push(statement);
        if (statement.includes('SELECT t.board_id, b.tenant_id')) {
          return { rows: [{ board_id: task.boardId, tenant_id: identity.tenantId, owner_user_id: identity.ownerUserId }] };
        }
        if (statement.includes('SELECT t.*, b.archived_at')) return { rows: [taskRow] };
        if (statement.includes('FROM continuation_outbox')) {
          return { rows: [{ status: 'completed', reconcile_lease_valid: true }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const result = await markContinuationRunning({
      pool: { connect: vi.fn(async () => client) }, boardsTable: 'boards', tasksTable: 'tasks',
      commentsTable: 'comments', executionsTable: 'executions', continuationOutboxTable: 'continuation_outbox',
    } as never, task.id, 'continuation-run');

    expect(result?.status).toBe('in_review');
    expect(sql.some((statement) => statement.includes('UPDATE tasks'))).toBe(false);
  });

  it('过期 reconcile lease 不能更新仍为 dispatched 的续跑任务', async () => {
    const sql: string[] = [];
    const taskRow = {
      id: task.id, board_id: task.boardId, identifier: task.identifier, title: task.title,
      description: task.description, status: 'in_review', priority: task.priority, labels: [],
      sort_order: task.sortOrder, comment_count: task.commentCount, version: task.version,
      created_at: task.createdAt, updated_at: task.updatedAt, board_archived_at: null,
    };
    const client = {
      query: vi.fn(async (statement: string) => {
        sql.push(statement);
        if (statement.includes('SELECT t.board_id, b.tenant_id')) {
          return { rows: [{ board_id: task.boardId, tenant_id: identity.tenantId, owner_user_id: identity.ownerUserId }] };
        }
        if (statement.includes('SELECT t.*, b.archived_at')) return { rows: [taskRow] };
        if (statement.includes('FROM continuation_outbox')) {
          return { rows: [{ status: 'dispatched', reconcile_lease_valid: false }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    await markContinuationRunning({
      pool: { connect: vi.fn(async () => client) }, boardsTable: 'boards', tasksTable: 'tasks',
      commentsTable: 'comments', executionsTable: 'executions', continuationOutboxTable: 'continuation_outbox',
    } as never, task.id, 'continuation-run', 'expired-lease');

    expect(sql.some((statement) => statement.includes('clock_timestamp()'))).toBe(true);
    expect(sql.some((statement) => statement.includes('UPDATE tasks'))).toBe(false);
  });

  it('实时续跑完成会提取文件卡并保存为评论附件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskboard-continuation-live-'));
    const userCwd = join(root, identity.tenantId, identity.ownerUserId);
    await mkdir(join(userCwd, 'assets'), { recursive: true });
    await writeFile(join(userCwd, 'assets', '实时交付.pdf'), 'live');
    try {
      const completeContinuation = vi.fn(async () => ({ ...task, status: 'in_review' as const }));
      const rig = makeRig({ completeContinuation }, { agentCwd: root });
      const runId = 'continuation-live-attachment';
      rig.runStore.get.mockResolvedValue({
        runId,
        sessionId: activeExecution.sessionId,
        userId: identity.ownerUserId,
        tenantId: identity.tenantId,
        status: 'completed',
        requestedAt: '2026-08-01T01:02:00.000Z',
        updatedAt: '2026-08-01T01:03:00.000Z',
        completedAt: '2026-08-01T01:03:00.000Z',
        metadata: { taskboardContinuation: true, taskboardTaskId: task.id },
      });
      vi.mocked(rig.eventStore.listByRun!).mockResolvedValue([{
        id: 'event-live-attachment',
        timestamp: '2026-08-01T01:03:00.000Z',
        type: 'assistant_message',
        runId,
        sessionId: activeExecution.sessionId,
        content: '实时交付\n[FILE]{"filePath":"assets/实时交付.pdf"}[/FILE]',
      } as never]);

      await rig.coordinator.handleRuntimeEvent({
        id: 'event-live-finished',
        timestamp: '2026-08-01T01:03:00.000Z',
        type: 'run_finished',
        runId,
        sessionId: activeExecution.sessionId,
        subtype: 'success',
        numTurns: 1,
      } as never);

      expect(completeContinuation).toHaveBeenCalledWith(task.id, runId, {
        status: 'succeeded',
        commentBody: 'Agent 交付\n\n实时交付',
        attachments: [{
          originalName: '实时交付.pdf',
          relativePath: 'assets/实时交付.pdf',
          size: 4,
          mimeType: 'application/pdf',
          isImage: false,
        }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('自动对账补写遗漏的评论续跑终态回执与附件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskboard-continuation-reconcile-'));
    const userCwd = join(root, identity.tenantId, identity.ownerUserId);
    await mkdir(join(userCwd, 'assets'), { recursive: true });
    await writeFile(join(userCwd, 'assets', '重启交付.pdf'), 'reconcile');
    try {
      const runId = `taskboard-comment-${comments[1]!.id}`;
      const rig = makeRig({
        claimContinuationReconcileCandidates: vi.fn(async () => [{
          runId,
          taskId: task.id,
          sessionId: activeExecution.sessionId,
          leaseId: 'continuation-reconcile-lease',
        }]),
        completeContinuation: vi.fn(async () => ({ ...task, status: 'in_review' as const })),
      }, { agentCwd: root });
      rig.runStore.get.mockResolvedValue({
        runId,
        sessionId: activeExecution.sessionId,
        userId: identity.ownerUserId,
        tenantId: identity.tenantId,
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
        content: '等待态后的续跑交付\n[FILE]{"filePath":"assets/重启交付.pdf"}[/FILE]',
      } as never]);

      await rig.coordinator.reconcile();

      expect(rig.store.completeContinuation).toHaveBeenCalledWith(task.id, runId, {
        status: 'succeeded',
        commentBody: 'Agent 交付\n\n等待态后的续跑交付',
        attachments: [{
          originalName: '重启交付.pdf',
          relativePath: 'assets/重启交付.pdf',
          size: 9,
          mimeType: 'application/pdf',
          isImage: false,
        }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('按执行阶段解析默认模型：任务模型 > 阶段模型 > 看板模型 > 组织默认', async () => {
    const resolveModel = (ref: string) => ({ ref });
    const launch = async (ctx: Partial<TaskboardExecutionModelContext>, purpose?: TaskBoardExecutionPurpose) => {
      const rig = makeRig({
        getExecutionModelContext: vi.fn(async () => ({ boardOwnerUserId: identity.ownerUserId, ...ctx })),
      }, { resolveModel });
      return await (rig.coordinator as unknown as {
        resolveLaunch: (i: TaskboardIdentity, t: string, p?: TaskBoardExecutionPurpose)
          => Promise<{ explicitModelRef?: string; model: { ref: string } }>;
      }).resolveLaunch(identity, task.id, purpose);
    };
    const stages = { work: 'stage/work', review: 'stage/review', merge: 'stage/merge' };
    expect((await launch({ boardStageModels: stages }, 'review')).model.ref).toBe('stage/review');
    expect((await launch({ boardStageModels: stages }, 'work')).model.ref).toBe('stage/work');
    expect((await launch({ boardStageModels: stages }, 'merge')).model.ref).toBe('stage/merge');
    const overridden = await launch({ taskKind: 'integration', taskModel: 'task/explicit', boardStageModels: stages });
    expect([overridden.explicitModelRef, overridden.model.ref]).toEqual(['task/explicit', 'task/explicit']);
    expect((await launch({ boardModel: 'board/fallback', boardStageModels: { review: 'stage/review' } }, 'work')).model.ref).toBe('board/fallback');
    expect((await launch({}, 'merge')).model.ref).toBe('model-default');
  });
});

function makeRig(
  overrides: Partial<TaskboardExecutionStore> = {},
  options: { agentCwd?: string; resolveModel?: (ref: string) => { ref: string } | null } = {},
) {
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
    stagePendingRun: vi.fn(),
    cancelPendingTaskboardRun: vi.fn(async () => null),
    activateCreatedRun: vi.fn(async (runId: string): Promise<RunRecord> => ({
      runId,
      sessionId: activeExecution.sessionId,
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: { schedulerState: 'ready' },
    })),
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
  const writeSessionTitle = vi.fn(async () => null);
  const coordinator = new TaskboardExecutionCoordinator({
    store,
    scheduler,
    runStore,
    sessionCatalog,
    eventStore,
    agentCwd: options.agentCwd ?? '/agent',
    executionConfig: createExecutionConfig({ tenantDefaultTarget: 'server-remote' }),
    resolveDefaultModel: () => ({ ref: 'model-default' }),
    ...(options.resolveModel ? { resolveModel: options.resolveModel } : {}),
    writeSessionTitle,
  });
  return { coordinator, store, scheduler, runStore, sessionCatalog, eventStore, writeSessionTitle };
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
