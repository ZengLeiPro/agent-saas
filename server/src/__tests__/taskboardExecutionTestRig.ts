import { vi } from 'vitest';

import type {
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore } from '../runtime/types.js';
import { TaskboardExecutionCoordinator } from '../taskboard/executionService.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionStore,
  TaskboardIdentity,
} from '../taskboard/types.js';

export const identity: TaskboardIdentity = {
  tenantId: 'tenant-a',
  ownerUserId: 'user-1',
  username: 'alice',
  userRole: 'user',
};

export const task: TaskBoardTask = {
  id: 'task-1',
  boardId: 'board-1',
  identifier: 'TASK-1',
  title: '实现执行闭环',
  description: '使用最新任务内容',
  branch: 'task/TASK-1-feature',
  attachments: [{
    attachmentId: '11111111-1111-4111-8111-111111111111',
    originalName: '需求图.png',
    relativePath: 'uploads/需求图.png',
    size: 1024,
    mimeType: 'image/png',
    isImage: true,
  }],
  status: 'todo',
  priority: 'high',
  labels: ['agent'],
  sortOrder: 1024,
  commentCount: 1,
  version: 3,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

export const comment: TaskBoardComment = {
  id: 'comment-1',
  taskId: task.id,
  body: '以评论里的验收条件为准',
  attachments: [{
    attachmentId: '22222222-2222-4222-8222-222222222222',
    originalName: '验收视频.mp4',
    relativePath: 'uploads/验收视频.mp4',
    size: 2048,
    mimeType: 'video/mp4',
    isImage: false,
  }],
  authorType: 'user',
  authorId: identity.ownerUserId,
  authorName: identity.username,
  version: 1,
  createdAt: '2026-08-01T01:00:00.000Z',
  updatedAt: '2026-08-01T01:00:00.000Z',
};

export function execution(input: Partial<TaskBoardExecution> = {}): TaskBoardExecution {
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
    purpose: input.purpose ?? 'work',
  };
}

export function makeRig(
  overrides: Partial<TaskboardExecutionStore> = {},
  coordinatorOptions: Partial<ConstructorParameters<typeof TaskboardExecutionCoordinator>[0]> = {},
) {
  const dispatches = new Map<string, {
    executionId: string;
    payload: Parameters<TaskboardExecutionStore['claimExecution']>[2]['dispatch'];
  }>();
  const store = {
    listExecutions: vi.fn(async () => []),
    searchExecutions: vi.fn(async () => ({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false })),
    getExecutionModelContext: vi.fn(async () => ({ boardOwnerUserId: identity.ownerUserId })),
    claimExecution: vi.fn(async (_identity, _taskId, input) => {
      dispatches.set(input.runId, { executionId: input.executionId, payload: input.dispatch });
      return {
        task: { ...task, status: 'in_progress' as const, version: task.version + 1 },
        execution: execution({
          id: input.executionId,
          runId: input.runId,
          sessionId: input.sessionId,
          purpose: input.purpose ?? 'work',
        }),
      };
    }),
    getExecutionContextByRunId: vi.fn(async (runId: string): Promise<TaskboardExecutionContext | null> => ({
      identity,
      task,
      boardPrompt: '只修改与任务直接相关的文件。',
      comments: [comment],
      execution: execution({ runId }),
    })),
    getExecutionContextBySessionId: vi.fn(async (sessionId: string): Promise<TaskboardExecutionContext | null> => ({
      identity,
      task,
      boardPrompt: '只修改与任务直接相关的文件。',
      comments: [comment],
      execution: execution({ sessionId }),
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
    enqueueContinuation: vi.fn(async () => true), claimContinuationDispatch: vi.fn(async () => null),
    markContinuationDispatchSucceeded: vi.fn(async () => true), retryContinuationDispatch: vi.fn(async () => true),
    claimContinuationReconcileCandidates: vi.fn(async () => []), releaseContinuationReconcile: vi.fn(async () => true),
    finishContinuation: vi.fn(async () => true), markContinuationRunning: vi.fn(async () => task),
    completeContinuation: vi.fn(async () => task),
    setExecutionStatus: vi.fn(async () => execution({ status: 'running' })),
    setExecutionStatusFromReconcile: vi.fn(async () => execution({ status: 'running' })),
    completeExecution: vi.fn(async () => ({ task, execution: execution({ status: 'succeeded' }) })),
    completeExecutionFromReconcile: vi.fn(async () => ({ task, execution: execution({ status: 'succeeded' }) })),
    ...overrides,
  } as TaskboardExecutionStore;
  const scheduler = {
    enqueue: vi.fn(async (input) => ({
      ...input,
      status: 'pending',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      metadata: input.metadata ?? {},
    })),
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
  const writeSessionTitle = vi.fn(async () => null);
  const coordinator = new TaskboardExecutionCoordinator({
    store,
    scheduler: scheduler as never,
    runStore,
    sessionCatalog,
    eventStore,
    agentCwd: '/agent-workspaces',
    executionConfig: createExecutionConfig({ tenantDefaultTarget: 'server-remote' }),
    resolveDefaultModel: () => ({ ref: 'model-default' }),
    writeSessionTitle,
    ...coordinatorOptions,
  });
  return { coordinator, store, scheduler, runStore, sessionCatalog, eventStore, writeSessionTitle };
}
