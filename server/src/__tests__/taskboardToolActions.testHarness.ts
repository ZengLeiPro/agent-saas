import { vi } from 'vitest';

import type {
  TaskBoard,
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionService,
  TaskboardIdentity,
  TaskboardService,
} from '../taskboard/types.js';

export const identity: TaskboardIdentity = {
  tenantId: 'tenant-a',
  ownerUserId: 'user-1',
  username: 'alice',
  userRole: 'user',
};

export const board: TaskBoard = {
  id: 'board-1',
  name: '迭代任务',
  visibility: 'personal',
  ownerUserId: identity.ownerUserId, role: 'owner',
  canManage: true,
  prompt: '',
  version: 1,
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

export const task: TaskBoardTask = {
  id: 'task-1',
  boardId: board.id,
  identifier: 'TASK-1',
  title: '实现功能',
  description: '',
  branch: 'task/TASK-1-feature',
  status: 'in_review',
  priority: 'none',
  labels: [],
  sortOrder: 1_024,
  commentCount: 0,
  version: 4,
  createdAt: board.createdAt,
  updatedAt: board.updatedAt,
};

export const execution: TaskBoardExecution = {
  id: 'execution-1',
  taskId: task.id,
  runId: 'run-1',
  sessionId: 'session-1',
  status: 'queued',
  purpose: 'review',
  requestedBy: identity.ownerUserId,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
};

export function rig() {
  const service = {
    listBoards: vi.fn(async () => [board]),
    searchBoards: vi.fn(async () => ({ items: [board], page: 1, pageSize: 20, total: 1, hasMore: false })),
    getBoard: vi.fn(async () => board),
    listTasks: vi.fn(async () => []),
    searchTasks: vi.fn(async () => ({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false })),
    getTask: vi.fn(async () => task),
    getExecutionContextV2: vi.fn(async (_identity, taskId, input) => ({ task: { ...task, id: taskId }, ...(input.runId ? { execution } : {}) })),
    listComments: vi.fn(async () => []),
    searchComments: vi.fn(async () => ({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false })),
    finishExecutionV2: vi.fn(async (_identity, _runId, input) => ({ ...task, status: input.targetStatus })),
    createComment: vi.fn(async (_identity, taskId, input) => ({
      id: 'comment-1', taskId, body: input.body, attachments: input.attachments, authorType: 'user' as const,
      authorId: identity.ownerUserId, authorName: identity.username, version: 1,
      createdAt: board.createdAt, updatedAt: board.updatedAt,
    })),
    updateComment: vi.fn(async (_identity, id, input) => ({
      id, taskId: task.id, body: input.body, authorType: 'user' as const,
      authorId: identity.ownerUserId, authorName: identity.username, version: input.expectedVersion + 1,
      createdAt: board.createdAt, updatedAt: board.updatedAt,
    })),
    deleteComment: vi.fn(async (_identity, id, input) => ({
      id, taskId: task.id, body: '删除我', authorType: 'user' as const,
      authorId: identity.ownerUserId, authorName: identity.username, version: input.expectedVersion,
      createdAt: board.createdAt, updatedAt: board.updatedAt,
    })),
    createTask: vi.fn(async (_identity, _boardId, input) => ({
      ...task,
      id: 'task-new',
      identifier: 'TASK-2',
      status: input.status ?? 'backlog',
      title: input.title,
      branch: input.branch,
      version: 1,
    })),
    updateTask: vi.fn(async (_identity, _taskId, input) => ({
      ...task,
      ...(input.branch === null ? { branch: undefined } : input.branch ? { branch: input.branch } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      version: task.version + 1,
    })),
    deleteTask: vi.fn(async () => ({ ...task, deletedAt: task.updatedAt, version: task.version + 1 })),
    rollbackTaskCreation: vi.fn(async () => ({ ...task, deletedAt: task.updatedAt, version: task.version + 1 })),
    moveTask: vi.fn(async (_identity, _taskId, input) => ({
      ...task,
      status: input.status,
      version: task.version + 1,
    })),
    cancelIntegrationTask: vi.fn(async (_identity, _taskId, input) => ({
      ...task,
      kind: 'integration' as const,
      status: 'canceled' as const,
      version: input.expectedVersion + 1,
    })),
    inspectExecutionPullRequestV2: vi.fn(async () => ({
      gateStatus: 'success' as const,
      receipt: {
        inspectionId: 'inspection-1', digest: 'digest', executionId: execution.id,
        taskId: task.id, purpose: 'review' as const, repositoryId: 'repo-1',
        providerPullRequestId: '42', headOid: 'head-42', providerQueriedAt: task.updatedAt,
      },
      snapshot: {
        providerPullRequestId: '42', number: 42, state: 'open' as const, draft: false,
        headRef: task.branch!, headOid: 'head-42', baseRef: 'main', baseOid: 'base-1',
        mergeable: true, requiredChecksKnown: true,
        requiredChecks: [{ name: 'Build & Check', status: 'success' as const }],
        subjectDigest: 'subject-42', repositoryId: 'repo-1', providerQueriedAt: task.updatedAt,
        workflowRuns: [],
      },
    })),
  } as unknown as TaskboardService;
  const executionService = {
    listExecutions: vi.fn(async () => [execution]),
    searchExecutions: vi.fn(async () => ({
      items: [execution], page: 1, pageSize: 20, total: 1, hasMore: false,
    })),
    startExecution: vi.fn(async () => ({
      task: { ...task, status: 'in_progress' as const, version: task.version + 1 },
      execution,
    })),
    startDirectExecution: vi.fn(async () => ({
      task: { ...task, status: 'in_progress' as const, version: task.version + 1 },
      execution,
    })),
  } satisfies TaskboardExecutionService;
  const executionStore = {
    getExecutionContextByRunId: vi.fn(),
    getExecutionContextBySessionId: vi.fn(),
    updateTaskBranchFromExecution: vi.fn(async (_identity, _runId, branch) => ({
      ...task, branch: branch ?? undefined, version: task.version + 1,
    })),
    createTaskFromExecution: vi.fn(async (_identity, _runId, input) => ({
      ...task, id: 'task-new', identifier: 'TASK-2', title: input.title,
      status: 'todo' as const, version: 1,
    })),
    createTaskFromExecutionWithResult: vi.fn(async (_identity, _runId, input) => ({ task: { ...task, id: 'task-new', identifier: 'TASK-2', title: input.title, status: 'todo' as const, version: 1 }, created: true })),
    moveTaskFromExecution: vi.fn(async (_identity, _runId, status) => ({
      ...task,
      status,
      version: task.version + 1,
    })),
  };
  const options = {
    service: () => service,
    executionService: () => executionService,
    executionStore: () => executionStore,
  };
  return { service, executionService, executionStore, options };
}

export function executionScope(purpose: 'work' | 'review' | 'merge', protocolVersion?: 2): { execution: TaskboardExecutionContext } {
  return {
    execution: {
      identity,
      task: { ...task, status: 'in_progress', ...(purpose === 'merge' ? { kind: 'integration' as const, workflowVersion: 3 } : {}) },
      boardPrompt: '',
      comments: [],
      execution: { ...execution, purpose, status: 'running', ...(protocolVersion ? { protocolVersion } : {}) },
    },
  };
}
