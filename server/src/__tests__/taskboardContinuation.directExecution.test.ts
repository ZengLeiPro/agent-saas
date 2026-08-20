import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import {
  completeContinuation,
  loadContinuationContext,
  markContinuationRunning,
} from '../taskboard/continuationStore.js';
import { TaskboardExecutionCoordinator } from '../taskboard/executionService.js';
import {
  TaskboardValidationError,
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

describe('任务看板后续正式执行', () => {
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
      purpose: 'work',
      trigger: 'initial',
    }));
  });

  it('integration 评论在无 active execution 时只创建 merge execution', async () => {
    const integration = { ...task, kind: 'integration' as const, status: 'todo' as const };
    const claimed = { ...activeExecution, taskId: integration.id, purpose: 'merge' as const };
    const rig = makeRig({
      getContinuationContext: vi.fn(async () => ({
        task: integration, comment: comments[1]!, pendingComments: comments,
      })),
      getExecutionModelContext: vi.fn(async () => ({
        taskKind: 'integration' as const, boardOwnerUserId: identity.ownerUserId,
      })),
      claimExecution: vi.fn(async (_identity, _taskId, input) => ({
        task: { ...integration, status: 'in_progress' as const },
        execution: { ...claimed, id: input.executionId, runId: input.runId, sessionId: input.sessionId },
      })),
    });

    await rig.coordinator.continueExecution(identity, integration.id, comments[1]!.id);

    expect(rig.store.claimExecution).toHaveBeenCalledWith(identity, integration.id, expect.objectContaining({
      purpose: 'merge', trigger: 'comment', protocolVersion: 2,
    }));
    expect(rig.store.enqueueContinuation).not.toHaveBeenCalled();
  });

  it('Workflow v3 无 active execution 时评论不得创建 merge execution', async () => {
    const integration = { ...task, kind: 'integration' as const, workflowVersion: 3 as const, status: 'todo' as const };
    const rig = makeRig({
      getContinuationContext: vi.fn(async () => ({
        task: integration, comment: comments[1]!, pendingComments: comments,
      })),
    });

    await expect(rig.coordinator.continueExecution(identity, integration.id, comments[1]!.id))
      .rejects.toMatchObject({ code: 'TASKBOARD_V3_COMMENT_CONTINUATION_REQUIRES_ACTIVE' });
    expect(rig.store.claimExecution).not.toHaveBeenCalled();
  });

  it('Workflow v3 可通过评论继续 active work execution', async () => {
    const integration = { ...task, kind: 'integration' as const, workflowVersion: 3 as const };
    const execution = { ...activeExecution, taskId: integration.id };
    const rig = makeRig({
      getContinuationContext: vi.fn(async () => ({
        task: integration, comment: comments[1]!, pendingComments: comments,
        activeExecution: execution, latestExecution: execution,
      })),
    });

    await rig.coordinator.continueExecution(identity, integration.id, comments[1]!.id);

    expect(rig.store.enqueueContinuation).toHaveBeenCalled();
    expect(rig.store.claimExecution).not.toHaveBeenCalled();
  });

  it('终态、待合并、merged 与 blocked 评论均不得再次派发', async () => {
    for (const terminalTask of [
      { ...task, status: 'done' as const },
      { ...task, status: 'ready_to_merge' as const },
      { ...task, status: 'in_review' as const, mergedCommitOid: 'abc123' },
      { ...task, status: 'blocked' as const },
    ]) {
      const rig = makeRig({
        getContinuationContext: vi.fn(async () => ({
          task: terminalTask, comment: comments[1]!, pendingComments: comments,
        })),
      });
      await expect(rig.coordinator.continueExecution(identity, terminalTask.id, comments[1]!.id))
        .rejects.toBeInstanceOf(TaskboardValidationError);
      expect(rig.store.claimExecution).not.toHaveBeenCalled();
      expect(rig.store.enqueueContinuation).not.toHaveBeenCalled();
    }
  });

});

function makeRig(
  overrides: Partial<TaskboardExecutionStore> = {},
  options: { agentCwd?: string } = {},
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
