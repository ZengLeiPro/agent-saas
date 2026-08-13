import type {
  TaskBoardExecutionPurpose,
  TaskBoardPriority,
  TaskBoardStatus,
  TaskBoardTaskPatchInput,
} from '../../../shared/src/types/taskboard.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionService,
  TaskboardExecutionStore,
  TaskboardIdentity,
  TaskboardService,
} from '../taskboard/types.js';

export const TASKBOARD_MANAGE_ACTIONS = ['list', 'create', 'update', 'move', 'execute'] as const;

export interface TaskboardManageInput {
  action: string;
  id?: string;
  boardId?: string;
  title?: string;
  description?: string;
  branch?: string | null;
  status?: TaskBoardStatus;
  priority?: TaskBoardPriority;
  labels?: string[];
  dueAt?: string | null;
  model?: string | null;
  purpose?: TaskBoardExecutionPurpose;
  search?: string;
  includeArchived?: boolean;
  /** create 时立即把新任务派发给独立 work Agent。 */
  dispatch?: boolean;
}

export interface TaskboardToolOptions {
  service: () => TaskboardService | undefined;
  executionService?: () => TaskboardExecutionService | undefined;
  executionStore?: () => Pick<
    TaskboardExecutionStore,
    'getExecutionContextByRunId' | 'moveTaskFromExecution'
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

  switch (input.action) {
    case 'list':
      return listTaskboard(service, options.executionService?.(), identity, input);
    case 'create': {
      const boardId = requireField(input.boardId, 'boardId');
      if (input.dispatch && input.status && input.status !== 'todo') {
        throw new Error('dispatch=true 只支持创建 todo 任务');
      }
      const executionService = input.dispatch ? options.executionService?.() : undefined;
      if (input.dispatch && !executionService) throw new Error('任务看板 Agent 执行服务未启用');
      const task = await service.createTask(identity, boardId, {
        title: requireField(input.title, 'title'),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        status: input.status ?? 'todo',
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.labels ? { labels: input.labels } : {}),
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      if (!input.dispatch) return { created: true, task };
      const result = await executionService!.startExecution(identity, task.id, {
        expectedVersion: task.version,
        purpose: 'work',
      });
      return { created: true, dispatched: true, ...result };
    }
    case 'update': {
      const id = requireField(input.id, 'id');
      const current = await service.getTask(identity, id);
      const patch: Omit<TaskBoardTaskPatchInput, 'expectedVersion'> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.branch !== undefined) patch.branch = input.branch;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.labels !== undefined) patch.labels = input.labels;
      if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
      if (input.model !== undefined) patch.model = input.model;
      if (Object.keys(patch).length === 0) throw new Error('action=update 至少需要一个任务字段');
      const task = await service.updateTask(identity, id, { ...patch, expectedVersion: current.version });
      return { updated: true, task };
    }
    case 'move': {
      const id = requireField(input.id, 'id');
      const status = input.status;
      if (!status) throw new Error('action=move 需要提供 status');
      if (scope.execution) {
        const executionStore = options.executionStore?.();
        if (!executionStore || (status !== 'done' && status !== 'todo')) {
          throw new Error('任务看板复核回写服务未启用');
        }
        const task = await executionStore.moveTaskFromExecution(
          identity,
          scope.execution.execution.runId,
          status,
        );
        return { moved: true, task };
      }
      const current = await service.getTask(identity, id);
      const peers = (await service.listTasks(identity, current.boardId, { statuses: [status] }))
        .filter((task) => task.id !== id && !task.archivedAt);
      const previousTaskId = peers.length > 0 ? peers[peers.length - 1]!.id : undefined;
      const task = await service.moveTask(identity, id, {
        status,
        ...(previousTaskId ? { previousTaskId } : {}),
        expectedVersion: current.version,
      });
      return { moved: true, task };
    }
    case 'execute': {
      const executionService = options.executionService?.();
      if (!executionService) throw new Error('任务看板 Agent 执行服务未启用');
      const id = requireField(input.id, 'id');
      const current = await service.getTask(identity, id);
      const purpose = input.purpose ?? (current.status === 'in_review' ? 'review' : 'work');
      const result = await executionService.startExecution(identity, id, {
        expectedVersion: current.version,
        purpose,
      });
      return { executed: true, ...result };
    }
    default:
      throw new Error(`target=taskboard 不支持 action=${input.action}`);
  }
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
        || (input.status !== 'done' && input.status !== 'todo')
      ) {
        throw new Error('只有当前任务的独立复核 Agent 可以确认 done 或退回 todo');
      }
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

async function listTaskboard(
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
  if (input.boardId) {
    const tasks = await service.listTasks(identity, input.boardId, {
      includeArchived: input.includeArchived,
      ...(input.search ? { search: input.search } : {}),
      ...(input.status ? { statuses: [input.status] } : {}),
      ...(input.priority ? { priorities: [input.priority] } : {}),
    });
    return { count: tasks.length, tasks };
  }
  const boards = await service.listBoards(identity, input.includeArchived);
  return { count: boards.length, boards };
}

function requireField(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`action 需要提供 ${field}`);
  return normalized;
}
