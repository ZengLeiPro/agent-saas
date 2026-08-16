import { createHash } from 'node:crypto';

import type {
  TaskBoardExecutionPurpose,
  TaskBoardPriority,
  TaskBoardStatus,
  TaskBoardTask,
  TaskBoardTaskPatchInput,
  TaskBoardVisibility,
} from '../../../shared/src/types/taskboard.js';
import { TaskboardPermissionError } from '../taskboard/types.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionService,
  TaskboardExecutionStore,
  TaskboardIdentity,
  TaskboardService,
  TaskboardTaskSearchFilter,
} from '../taskboard/types.js';

export const TASKBOARD_LEGACY_ACTIONS = ['list', 'create', 'update', 'move', 'execute'] as const;
export const TASKBOARD_RESOURCE_ACTIONS = [
  'board.list',
  'board.search',
  'board.get',
  'board.create',
  'board.update',
  'board.archive',
  'board.restore',
  'task.list',
  'task.search',
  'task.get',
  'task.create',
  'task.update',
  'task.move',
  'task.archive',
  'task.restore',
  'task.dispatch',
  'comment.list',
  'comment.create',
  'comment.update',
  'comment.delete',
  'execution.list',
] as const;
export const TASKBOARD_MANAGE_ACTIONS = [
  ...TASKBOARD_LEGACY_ACTIONS,
  ...TASKBOARD_RESOURCE_ACTIONS,
] as const;
export const TASKBOARD_READ_ACTIONS = [
  'list',
  'board.list',
  'board.search',
  'board.get',
  'task.list',
  'task.search',
  'task.get',
  'comment.list',
  'execution.list',
] as const;

export interface TaskboardManageInput {
  action: string;
  id?: string;
  boardId?: string;
  taskId?: string;
  name?: string;
  title?: string;
  description?: string;
  prompt?: string;
  visibility?: TaskBoardVisibility;
  branch?: string | null;
  status?: TaskBoardStatus;
  statuses?: TaskBoardStatus[];
  priority?: TaskBoardPriority;
  priorities?: TaskBoardPriority[];
  labels?: string[];
  dueAt?: string | null;
  model?: string | null;
  purpose?: TaskBoardExecutionPurpose;
  body?: string;
  search?: string;
  boardName?: string;
  creatorUserId?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  dueAfter?: string;
  dueBefore?: string;
  includeArchived?: boolean;
  expectedVersion?: number;
  previousTaskId?: string;
  nextTaskId?: string;
  page?: number;
  pageSize?: number;
  /** create/task.create 时立即把新任务派发给独立 work Agent。 */
  dispatch?: boolean;
}

export interface TaskboardToolOptions {
  service: () => TaskboardService | undefined;
  executionService?: () => TaskboardExecutionService | undefined;
  executionStore?: () => Pick<
    TaskboardExecutionStore,
    | 'getExecutionContextByRunId'
    | 'getExecutionContextBySessionId'
    | 'updateTaskBranchFromExecution'
    | 'createTaskFromExecution'
    | 'moveTaskFromExecution'
  > | undefined;
}

export interface TaskboardActionScope {
  /** 当前调用来自看板 Execution 时存在，用于服务端 fencing。 */
  execution?: TaskboardExecutionContext;
}

export async function invokeTaskboardAction(
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  scope: TaskboardActionScope = {},
): Promise<Record<string, unknown>> {
  const service = options.service();
  if (!service) throw new Error('任务看板服务未启用');
  assertExecutionScope(input, scope.execution, identity);
  if (
    !scope.execution
    && TASKBOARD_LEGACY_ACTIONS.includes(input.action as (typeof TASKBOARD_LEGACY_ACTIONS)[number])
  ) {
    throw new Error('普通会话请使用 board/task/comment/execution 资源 action');
  }

  switch (input.action) {
    case 'board.list':
    case 'board.search':
      return boardSearch(service, identity, input);
    case 'board.get':
      return { board: await service.getBoard(identity, requireId(input, 'boardId')) };
    case 'board.create': {
      const board = await service.createBoard(identity, {
        name: requireField(input.name, 'name'),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(typeof input.model === 'string' ? { model: input.model } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
      });
      return { created: true, board };
    }
    case 'board.update': {
      const boardId = requireId(input, 'boardId');
      const expectedVersion = requireVersion(input);
      const patch = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      };
      if (Object.keys(patch).length === 0) throw new Error('board.update 至少需要一个看板字段');
      return { updated: true, board: await service.updateBoard(identity, boardId, { ...patch, expectedVersion }) };
    }
    case 'board.archive':
      return {
        archived: true,
        board: await service.archiveBoard(identity, requireId(input, 'boardId'), { expectedVersion: requireVersion(input) }),
      };
    case 'board.restore':
      return {
        restored: true,
        board: await service.restoreBoard(identity, requireId(input, 'boardId'), { expectedVersion: requireVersion(input) }),
      };
    case 'task.list':
    case 'task.search':
      return taskSearch(service, identity, input, input.action === 'task.list');
    case 'task.get':
      return { task: await service.getTask(identity, requireId(input, 'taskId')) };
    case 'task.create':
      return createTask(service, options.executionService?.(), identity, input);
    case 'task.update': {
      const taskId = requireId(input, 'taskId');
      const patch = taskPatch(input);
      return {
        updated: true,
        task: await service.updateTask(identity, taskId, { ...patch, expectedVersion: requireVersion(input) }),
      };
    }
    case 'task.move':
      return moveTask(service, identity, input, false);
    case 'task.archive':
      return {
        archived: true,
        task: await service.archiveTask(identity, requireId(input, 'taskId'), { expectedVersion: requireVersion(input) }),
      };
    case 'task.restore':
      return {
        restored: true,
        task: await service.restoreTask(identity, requireId(input, 'taskId'), { expectedVersion: requireVersion(input) }),
      };
    case 'task.dispatch':
      return dispatchTask(service, options.executionService?.(), identity, input, false);
    case 'comment.list': {
      const result = await service.searchComments(identity, requireId(input, 'taskId'), {
        page: input.page,
        pageSize: input.pageSize,
      });
      return {
        count: result.items.length,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        hasMore: result.hasMore,
        comments: result.items,
      };
    }
    case 'comment.create': {
      const comment = await service.createComment(identity, requireId(input, 'taskId'), {
        body: requireField(input.body, 'body'),
      });
      return { created: true, comment };
    }
    case 'comment.update': {
      const comment = await service.updateComment(identity, requireId(input, 'id'), {
        body: requireField(input.body, 'body'),
        expectedVersion: requireVersion(input),
      });
      return { updated: true, comment };
    }
    case 'comment.delete': {
      const comment = await service.deleteComment(identity, requireId(input, 'id'), {
        expectedVersion: requireVersion(input),
      });
      return { deleted: true, comment };
    }
    case 'execution.list': {
      const result = await requireExecutionService(options.executionService?.()).searchExecutions(
        identity,
        requireId(input, 'taskId'),
        { page: input.page, pageSize: input.pageSize },
      );
      return {
        count: result.items.length,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        hasMore: result.hasMore,
        executions: result.items,
      };
    }
    case 'list':
      return listLegacy(service, options.executionService?.(), identity, input);
    case 'create':
      if (scope.execution) return createExecutionTask(options, identity, input, scope.execution);
      return createLegacyTask(service, options.executionService?.(), identity, input);
    case 'update':
      if (scope.execution) return updateExecutionTask(options, identity, input, scope.execution);
      return updateLegacyTask(service, identity, input);
    case 'move':
      return moveLegacyTask(service, options, identity, input, scope.execution);
    case 'execute':
      return dispatchTask(service, options.executionService?.(), identity, input, true);
    default:
      throw new Error(`target=taskboard 不支持 action=${input.action}`);
  }
}

function taskboardCreateRequestId(input: TaskboardManageInput, scope: TaskboardActionScope): string {
  const sourceRunId = scope.execution?.execution.runId ?? 'unknown-run';
  const digest = createHash('sha256').update(JSON.stringify({
    boardId: input.boardId,
    title: input.title,
    description: input.description,
    branch: input.branch,
    status: input.status,
    priority: input.priority,
    labels: input.labels,
    dueAt: input.dueAt,
    model: input.model,
  })).digest('hex').slice(0, 32);
  return `taskboard-tool:${sourceRunId.slice(-64)}:${digest}`;
}

function assertExecutionScope(
  input: TaskboardManageInput,
  context: TaskboardExecutionContext | undefined,
  identity: TaskboardIdentity,
): void {
  if (!context) return;
  if (
    context.identity.tenantId !== identity.tenantId
    || context.identity.ownerUserId !== identity.ownerUserId
  ) throw new Error('任务看板执行身份不匹配');
  if (!['queued', 'running', 'waiting_user', 'waiting_approval'].includes(context.execution.status)) {
    throw new Error('任务看板执行已终止，不能继续回写');
  }
  if (!TASKBOARD_LEGACY_ACTIONS.includes(input.action as (typeof TASKBOARD_LEGACY_ACTIONS)[number])) {
    throw new Error('看板 Agent Execution 只能使用兼容回写 action，不能进入普通会话管理域');
  }
  const currentTask = context.task;
  switch (input.action) {
    case 'list':
      if (input.id !== currentTask.id || input.boardId || input.includeArchived) {
        throw new Error('看板 Agent 只能读取当前任务详情');
      }
      return;
    case 'update': {
      const changed = ['title', 'description', 'priority', 'labels', 'dueAt', 'model']
        .some((field) => input[field as keyof TaskboardManageInput] !== undefined);
      if (input.id !== currentTask.id || input.branch === undefined || changed) {
        throw new Error('看板 Agent 只能回写当前任务的 branch 字段');
      }
      return;
    }
    case 'move':
      if (
        input.id !== currentTask.id
        || context.execution.purpose !== 'review'
        || !['ready_to_merge', 'todo', 'blocked'].includes(input.status ?? '')
      ) throw new Error('只有当前任务的复核 Agent 可以确认待合并、退回待实施或标记阻塞');
      return;
    case 'create':
      if (input.boardId !== currentTask.boardId || (input.status !== undefined && input.status !== 'todo')) {
        throw new Error('看板 Agent 只能在当前看板创建 todo 后续任务');
      }
      return;
    case 'execute':
      throw new Error('看板 Agent 不能派发已有任务；请用 create + dispatch 创建独立后续 Agent');
    default:
      throw new Error(`看板 Agent 不支持 action=${input.action}`);
  }
}

async function boardSearch(
  service: TaskboardService,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
): Promise<Record<string, unknown>> {
  const result = await service.searchBoards(identity, {
    includeArchived: input.includeArchived,
    search: input.search,
    page: input.page,
    pageSize: input.pageSize,
  });
  return {
    count: result.items.length,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    hasMore: result.hasMore,
    boards: result.items,
  };
}

async function taskSearch(
  service: TaskboardService,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  requireBoard: boolean,
): Promise<Record<string, unknown>> {
  if (requireBoard) await service.getBoard(identity, requireField(input.boardId, 'boardId'));
  const filter: TaskboardTaskSearchFilter = {
    includeArchived: input.includeArchived,
    search: input.search,
    statuses: input.statuses ?? (input.status ? [input.status] : undefined),
    priorities: input.priorities ?? (input.priority ? [input.priority] : undefined),
    labels: input.labels,
    creatorUserId: input.creatorUserId,
    boardId: input.boardId,
    boardName: input.boardName,
    createdAfter: input.createdAfter,
    createdBefore: input.createdBefore,
    updatedAfter: input.updatedAfter,
    updatedBefore: input.updatedBefore,
    dueAfter: input.dueAfter,
    dueBefore: input.dueBefore,
    page: input.page,
    pageSize: input.pageSize,
  };
  const result = await service.searchTasks(identity, filter);
  return {
    count: result.items.length,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    hasMore: result.hasMore,
    tasks: result.items,
  };
}

async function createTask(
  service: TaskboardService,
  executionService: TaskboardExecutionService | undefined,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
): Promise<Record<string, unknown>> {
  const boardId = requireField(input.boardId, 'boardId');
  const dispatcher = input.dispatch ? requireExecutionService(executionService) : undefined;
  if (input.dispatch) await assertCanDispatch(service, identity, boardId);
  if (input.dispatch && input.status && input.status !== 'todo') {
    throw new Error('dispatch=true 只支持创建 todo 任务');
  }
  const task = await service.createTask(identity, boardId, {
    title: requireField(input.title, 'title'),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(typeof input.branch === 'string' ? { branch: input.branch } : {}),
    status: input.dispatch ? 'todo' : input.status,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(typeof input.dueAt === 'string' ? { dueAt: input.dueAt } : {}),
    ...(typeof input.model === 'string' ? { model: input.model } : {}),
  });
  if (!input.dispatch) return { created: true, task };
  return dispatchCreatedTask(dispatcher!, identity, task);
}

async function dispatchCreatedTask(
  executionService: TaskboardExecutionService,
  identity: TaskboardIdentity,
  task: TaskBoardTask,
): Promise<Record<string, unknown>> {
  try {
    const execution = executionService.startDirectExecution
      ? await executionService.startDirectExecution(identity, task.id, task.version)
      : await executionService.startExecution(identity, task.id, {
          expectedVersion: task.version,
          purpose: 'work',
        });
    return { created: true, dispatched: true, ...execution };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined;
    return {
      created: true,
      dispatched: false,
      task,
      dispatchError: {
        ...(code ? { code } : {}),
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function dispatchTask(
  service: TaskboardService,
  executionService: TaskboardExecutionService | undefined,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  legacy: boolean,
): Promise<Record<string, unknown>> {
  const taskId = requireId(input, legacy ? 'id' : 'taskId');
  const current = await service.getTask(identity, taskId);
  await assertCanDispatch(service, identity, current.boardId);
  const expectedVersion = legacy ? current.version : requireVersion(input);
  const purpose = input.purpose ?? (legacy && current.status === 'in_review' ? 'review' : 'work');
  const result = await requireExecutionService(executionService).startExecution(identity, taskId, {
    expectedVersion,
    purpose,
  });
  return { dispatched: true, executed: true, ...result };
}

async function moveTask(
  service: TaskboardService,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  legacy: boolean,
): Promise<Record<string, unknown>> {
  const taskId = requireId(input, legacy ? 'id' : 'taskId');
  if (!input.status) throw new Error(`${input.action} 需要提供 status`);
  const current = legacy ? await service.getTask(identity, taskId) : undefined;
  const task = await service.moveTask(identity, taskId, {
    status: input.status,
    ...(input.previousTaskId ? { previousTaskId: input.previousTaskId } : {}),
    ...(input.nextTaskId ? { nextTaskId: input.nextTaskId } : {}),
    expectedVersion: legacy ? current!.version : requireVersion(input),
  });
  return { moved: true, task };
}

async function listLegacy(
  service: TaskboardService,
  executionService: TaskboardExecutionService | undefined,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
): Promise<Record<string, unknown>> {
  if (input.id) {
    const task = await service.getTask(identity, input.id);
    const [comments, executions] = await Promise.all([
      service.listComments(identity, input.id),
      executionService?.listExecutions(identity, input.id) ?? Promise.resolve([]),
    ]);
    return { task, comments, executions };
  }
  if (input.boardId) return taskSearch(service, identity, input, true);
  return boardSearch(service, identity, input);
}

async function createExecutionTask(
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  execution: TaskboardExecutionContext,
): Promise<Record<string, unknown>> {
  const executionStore = options.executionStore?.();
  if (!executionStore) throw new Error('任务看板执行上下文服务未启用');
  const dispatcher = input.dispatch ? requireExecutionService(options.executionService?.()) : undefined;
  const task = await executionStore.createTaskFromExecution(identity, execution.execution.runId, {
    title: requireField(input.title, 'title'),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(typeof input.branch === 'string' ? { branch: input.branch } : {}),
    status: 'todo',
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(typeof input.dueAt === 'string' ? { dueAt: input.dueAt } : {}),
    ...(typeof input.model === 'string' ? { model: input.model } : {}),
    clientRequestId: taskboardCreateRequestId(input, { execution }),
  });
  if (!input.dispatch) return { created: true, task };
  return dispatchCreatedTask(dispatcher!, identity, task);
}

async function updateExecutionTask(
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  execution: TaskboardExecutionContext,
): Promise<Record<string, unknown>> {
  const executionStore = options.executionStore?.();
  if (!executionStore) throw new Error('任务看板执行上下文服务未启用');
  const task = await executionStore.updateTaskBranchFromExecution(
    identity,
    execution.execution.runId,
    input.branch ?? null,
  );
  return { updated: true, task };
}

async function createLegacyTask(
  service: TaskboardService,
  executionService: TaskboardExecutionService | undefined,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
): Promise<Record<string, unknown>> {
  return createTask(service, executionService, identity, { ...input, status: input.status ?? 'todo' });
}

async function updateLegacyTask(
  service: TaskboardService,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
): Promise<Record<string, unknown>> {
  const taskId = requireField(input.id, 'id');
  const current = await service.getTask(identity, taskId);
  const patch = taskPatch(input);
  return {
    updated: true,
    task: await service.updateTask(identity, taskId, { ...patch, expectedVersion: current.version }),
  };
}

async function moveLegacyTask(
  service: TaskboardService,
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  execution: TaskboardExecutionContext | undefined,
): Promise<Record<string, unknown>> {
  if (execution) {
    const status = input.status;
    const executionStore = options.executionStore?.();
    if (
      !executionStore
      || (status !== 'ready_to_merge' && status !== 'todo' && status !== 'blocked')
    ) {
      throw new Error('任务看板复核回写服务未启用');
    }
    const task = await executionStore.moveTaskFromExecution(identity, execution.execution.runId, status);
    return { moved: true, task };
  }
  const taskId = requireField(input.id, 'id');
  const current = await service.getTask(identity, taskId);
  if (!input.status) throw new Error('action=move 需要提供 status');
  const peers = (await service.listTasks(identity, current.boardId, { statuses: [input.status] }))
    .filter((task) => task.id !== taskId && !task.archivedAt);
  const previousTaskId = peers.length > 0 ? peers[peers.length - 1]!.id : undefined;
  const task = await service.moveTask(identity, taskId, {
    status: input.status,
    ...(previousTaskId ? { previousTaskId } : {}),
    expectedVersion: current.version,
  });
  return { moved: true, task };
}

function taskPatch(input: TaskboardManageInput): Omit<TaskBoardTaskPatchInput, 'expectedVersion'> {
  const patch: Omit<TaskBoardTaskPatchInput, 'expectedVersion'> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.branch !== undefined) patch.branch = input.branch;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
  if (input.model !== undefined) patch.model = input.model;
  if (Object.keys(patch).length === 0) throw new Error(`${input.action} 至少需要一个任务字段`);
  return patch;
}

async function assertCanDispatch(
  service: TaskboardService,
  identity: TaskboardIdentity,
  boardId: string,
): Promise<void> {
  const board = await service.getBoard(identity, boardId);
  if (!board.canManage) {
    throw new TaskboardPermissionError('Only the board owner may dispatch an Agent for this board');
  }
}

function requireExecutionService(service: TaskboardExecutionService | undefined): TaskboardExecutionService {
  if (!service) throw new Error('任务看板 Agent 执行服务未启用');
  return service;
}

function requireVersion(input: TaskboardManageInput): number {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion! < 1) {
    throw new Error(`${input.action} 需要提供 expectedVersion`);
  }
  return input.expectedVersion!;
}

function requireId(input: TaskboardManageInput, field: 'id' | 'boardId' | 'taskId'): string {
  return requireField(input[field], field);
}

function requireField(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`action 需要提供 ${field}`);
  return normalized;
}
