import { createHash } from 'node:crypto';

import type {
  TaskBoardContextReceipt,
  TaskBoardExecutionPurpose,
  TaskBoardPriority,
  TaskBoardStatus,
  TaskBoardTask,
  TaskBoardTaskKind,
  TaskBoardTaskPatchInput,
  TaskBoardUploadAttachment,
  TaskBoardVisibility,
} from '../../../shared/src/types/taskboard.js';
import { TaskboardPermissionError, TaskboardValidationError } from '../taskboard/types.js';
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
  'execution.context',
  'execution.comment',
  'execution.pull_request.set',
  'execution.review_subject.record',
  'execution.resolve',
  'integration.create',
  'integration.cancel',
  'integration.sources',
  'integration.source.inspect',
  'integration.source.merge',
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
  'execution.context',
  'integration.sources',
  'integration.source.inspect',
] as const;

export interface TaskboardAttachmentInput {
  attachmentId: string;
}

export interface TaskboardManageInput {
  action: string;
  id?: string;
  boardId?: string;
  taskId?: string;
  sourceId?: string;
  providerPullRequestId?: string;
  kind?: TaskBoardTaskKind;
  name?: string;
  title?: string;
  description?: string;
  prompt?: string;
  visibility?: TaskBoardVisibility;
  branch?: string | null;
  attachments?: TaskboardAttachmentInput[];
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
  include?: Array<'task' | 'board' | 'comments' | 'executions' | 'activity' | 'integrationSources'>;
  historyMode?: 'auto' | 'full' | 'delta';
  cursor?: string;
  limit?: number;
  resolutionId?: string;
  outcome?: string;
  summary?: string;
  reason?: string;
  evidence?: string[];
  receipt?: TaskBoardContextReceipt;
  deliveryTaskIds?: string[];
  expectedBoardVersion?: number;
}

export interface TaskboardToolOptions {
  service: () => TaskboardService | undefined;
  executionService?: () => TaskboardExecutionService | undefined;
  /** 解析当前用户会话上传的附件 ID；不得接受模型传入的工作区路径。 */
  resolveAttachments?: (
    identity: TaskboardIdentity,
    attachmentIds: readonly string[],
  ) => Promise<TaskBoardUploadAttachment[]>;
  /** 任务/评论持久化成功后，将已关联附件标记为 referenced。 */
  markAttachmentsReferenced?: (
    identity: TaskboardIdentity,
    attachments: readonly TaskBoardUploadAttachment[],
    refs: { sessionId?: string },
  ) => Promise<void>;
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
  /** 当前会话 ID，用于把已提交附件标记为该会话引用。 */
  sessionId?: string;
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
      return createTask(options, service, options.executionService?.(), identity, input, scope);
    case 'task.update': {
      const taskId = requireId(input, 'taskId');
      const attachments = await resolveTaskboardAttachments(options, identity, input.attachments);
      const patch = taskPatch(input, attachments);
      const task = await service.updateTask(identity, taskId, {
        ...patch,
        expectedVersion: requireVersion(input),
      });
      await markTaskboardAttachments(options, identity, attachments, scope);
      return { updated: true, task };
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
      const attachments = await resolveTaskboardAttachments(options, identity, input.attachments);
      const comment = await service.createComment(identity, requireId(input, 'taskId'), {
        body: input.body?.trim() ?? '',
        ...(attachments !== undefined ? { attachments } : {}),
      });
      await markTaskboardAttachments(options, identity, attachments, scope);
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
    case 'execution.context': {
      if (!service.getExecutionContextV2) throw new Error('任务看板上下文协议未启用');
      const taskId = scope.execution?.task.id ?? requireId(input, 'taskId');
      return await service.getExecutionContextV2(identity, taskId, {
        ...(scope.execution ? { runId: scope.execution.execution.runId } : {}),
        ...(input.include ? { include: input.include } : {}),
        history: {
          mode: input.historyMode ?? 'auto',
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        },
      }) as unknown as Record<string, unknown>;
    }
    case 'execution.comment': {
      if (!scope.execution || !service.createExecutionCommentV2) {
        throw new Error('仅当前任务 Execution 可以写入 Agent 进展评论');
      }
      const comment = await service.createExecutionCommentV2(
        identity,
        scope.execution.execution.runId,
        requireField(input.body, 'body'),
      );
      return { created: true, comment };
    }
    case 'execution.pull_request.set': {
      if (!scope.execution || !service.attachExecutionPullRequestV2) {
        throw new Error('仅当前 work Execution 可以登记 pull request');
      }
      const task = await service.attachExecutionPullRequestV2(
        identity,
        scope.execution.execution.runId,
        requireField(input.providerPullRequestId, 'providerPullRequestId'),
      );
      return { updated: true, task };
    }
    case 'execution.review_subject.record': {
      if (!scope.execution || !service.recordReviewedExecutionSubjectV2) {
        throw new Error('仅当前 review Execution 可以登记已审 subject');
      }
      const task = await service.recordReviewedExecutionSubjectV2(
        identity,
        scope.execution.execution.runId,
      );
      return { updated: true, task };
    }
    case 'execution.resolve': {
      if (!scope.execution || !service.resolveExecutionV2 || !input.receipt) {
        throw new Error('当前任务 Execution 缺少 resolution 服务或 context receipt');
      }
      const task = await service.resolveExecutionV2(identity, scope.execution.execution.runId, {
        ...(input.resolutionId ? { resolutionId: input.resolutionId } : {}),
        outcome: requireField(input.outcome, 'outcome'),
        summary: requireField(input.summary, 'summary'),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        receipt: input.receipt,
      });
      return { resolved: true, task };
    }
    case 'integration.create': {
      if (!service.createIntegrationBatch) throw new Error('任务看板集成批次服务未启用');
      if (!input.deliveryTaskIds?.length) throw new Error('integration.create 需要 deliveryTaskIds');
      if (!Number.isInteger(input.expectedBoardVersion)) throw new Error('integration.create 需要 expectedBoardVersion');
      const task = await service.createIntegrationBatch(identity, requireId(input, 'boardId'), {
        deliveryTaskIds: input.deliveryTaskIds,
        expectedBoardVersion: input.expectedBoardVersion!,
      }, 'manual_batch');
      return { created: true, task };
    }
    case 'integration.cancel': {
      if (!service.cancelIntegrationTask) throw new Error('任务看板集成取消服务未启用');
      const task = await service.cancelIntegrationTask(identity, requireId(input, 'taskId'), {
        expectedVersion: requireVersion(input),
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return { canceled: true, task };
    }
    case 'integration.sources': {
      if (!service.listIntegrationSources) throw new Error('任务看板集成来源服务未启用');
      const taskId = scope.execution?.task.id ?? requireId(input, 'taskId');
      const sources = await service.listIntegrationSources(identity, taskId);
      return { count: sources.length, sources };
    }
    case 'integration.source.inspect': {
      if (!scope.execution || !service.inspectIntegrationSourceV2) {
        throw new Error('仅当前 merge Execution 可以检查集成来源');
      }
      return await service.inspectIntegrationSourceV2(
        identity,
        scope.execution.execution.runId,
        requireField(input.sourceId, 'sourceId'),
      ) as unknown as Record<string, unknown>;
    }
    case 'integration.source.merge': {
      if (!scope.execution || !service.mergeIntegrationSourceV2) {
        throw new Error('仅当前 merge Execution 可以合并集成来源');
      }
      return await service.mergeIntegrationSourceV2(
        identity,
        scope.execution.execution.runId,
        requireField(input.sourceId, 'sourceId'),
      ) as unknown as Record<string, unknown>;
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
      if (scope.execution) return createExecutionTask(options, identity, input, scope.execution, scope);
      return createLegacyTask(options, service, options.executionService?.(), identity, input, scope);
    case 'update':
      if (scope.execution) return updateExecutionTask(options, identity, input, scope.execution);
      return updateLegacyTask(options, service, identity, input, scope);
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
    attachments: input.attachments?.map((attachment) => attachment.attachmentId),
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
  const executionActions = [
    'execution.context',
    'execution.comment',
    'execution.pull_request.set',
    'execution.review_subject.record',
    'execution.resolve',
    'integration.sources',
    'integration.source.inspect',
    'integration.source.merge',
  ];
  if (executionActions.includes(input.action)) {
    if (input.taskId && input.taskId !== context.task.id) {
      throw new Error('看板 Agent 只能操作当前任务');
    }
    if (input.action.startsWith('integration.') && context.task.kind !== 'integration') {
      throw new Error('只有 integration 任务可以读取集成来源');
    }
    return;
  }
  if (!TASKBOARD_LEGACY_ACTIONS.includes(input.action as (typeof TASKBOARD_LEGACY_ACTIONS)[number])) {
    throw new Error('看板 Agent Execution 只能使用当前任务协议 action，不能进入普通会话管理域');
  }
  const currentTask = context.task;
  switch (input.action) {
    case 'list':
      if (input.id !== currentTask.id || input.boardId || input.includeArchived) {
        throw new Error('看板 Agent 只能读取当前任务详情');
      }
      return;
    case 'update': {
      const changed = ['title', 'description', 'attachments', 'priority', 'labels', 'dueAt', 'model']
        .some((field) => input[field as keyof TaskboardManageInput] !== undefined);
      if (currentTask.kind === 'advisory'
        || context.execution.purpose !== 'work' || input.id !== currentTask.id || input.branch === undefined || changed) {
        throw new Error('看板 Agent 只能回写当前任务的 branch 字段，且须符合当前工作流能力');
      }
      return;
    }
    case 'move':
      if (context.execution.protocolVersion === 2) {
        throw new Error('当前 Execution 必须通过结构化 resolution 提交阶段结果');
      }
      if (
        input.id !== currentTask.id
        || context.execution.purpose !== 'review'
        || !['ready_to_merge', 'todo', 'blocked'].includes(input.status ?? '')
      ) throw new Error('只有当前任务的复核 Agent 可以确认待合并、退回待实施或标记阻塞');
      return;
    case 'create':
      if (
        currentTask.kind === 'advisory'
        || input.boardId !== currentTask.boardId
        || (input.status !== undefined && input.status !== 'todo')
        || context.execution.purpose === 'review'
        || (context.execution.purpose === 'work' && input.kind !== undefined && input.kind !== 'delivery')
        || (context.execution.purpose === 'merge' && (input.kind !== 'remediation' || !input.sourceId))
      ) {
        throw new Error('当前职责不能创建该后续任务');
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
    kinds: input.kind ? [input.kind] : undefined,
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
  options: TaskboardToolOptions,
  service: TaskboardService,
  executionService: TaskboardExecutionService | undefined,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  scope: TaskboardActionScope,
): Promise<Record<string, unknown>> {
  const boardId = requireField(input.boardId, 'boardId');
  const dispatcher = input.dispatch ? requireExecutionService(executionService) : undefined;
  if (input.dispatch) await assertCanDispatch(service, identity, boardId);
  if (input.dispatch && input.status && input.status !== 'todo') {
    throw new Error('dispatch=true 只支持创建 todo 任务');
  }
  const attachments = await resolveTaskboardAttachments(options, identity, input.attachments);
  const task = await service.createTask(identity, boardId, {
    title: requireField(input.title, 'title'),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(typeof input.branch === 'string' ? { branch: input.branch } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    status: input.dispatch ? 'todo' : input.status,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(typeof input.dueAt === 'string' ? { dueAt: input.dueAt } : {}),
    ...(typeof input.model === 'string' ? { model: input.model } : {}),
  });
  await markTaskboardAttachments(options, identity, attachments, scope);
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
  scope: TaskboardActionScope,
): Promise<Record<string, unknown>> {
  const executionStore = options.executionStore?.();
  if (!executionStore) throw new Error('任务看板执行上下文服务未启用');
  const kind = input.kind ?? (execution.task.kind === 'integration' ? 'remediation' : 'delivery');
  if (execution.task.kind === 'integration' && kind === 'remediation' && !input.sourceId) {
    throw new Error('integration remediation 任务需要 sourceId');
  }
  const dispatcher = input.dispatch ? requireExecutionService(options.executionService?.()) : undefined;
  const attachments = await resolveTaskboardAttachments(options, identity, input.attachments);
  let task = await executionStore.createTaskFromExecution(identity, execution.execution.runId, {
    title: requireField(input.title, 'title'),
    kind,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(typeof input.branch === 'string' ? { branch: input.branch } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    status: 'todo',
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(typeof input.dueAt === 'string' ? { dueAt: input.dueAt } : {}),
    ...(typeof input.model === 'string' ? { model: input.model } : {}),
    clientRequestId: taskboardCreateRequestId(input, { execution }),
  });
  await markTaskboardAttachments(options, identity, attachments, scope);
  if (kind === 'remediation' && input.sourceId) {
    const service = options.service();
    if (!service?.linkIntegrationRemediationV2) {
      throw new Error('任务看板 remediation 关联服务未启用');
    }
    await service.linkIntegrationRemediationV2(
      identity,
      execution.execution.runId,
      input.sourceId,
      task.id,
    );
    task = await service.getTask(identity, task.id);
  }
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
  options: TaskboardToolOptions,
  service: TaskboardService,
  executionService: TaskboardExecutionService | undefined,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  scope: TaskboardActionScope,
): Promise<Record<string, unknown>> {
  return createTask(
    options,
    service,
    executionService,
    identity,
    { ...input, status: input.status ?? 'todo' },
    scope,
  );
}

async function updateLegacyTask(
  options: TaskboardToolOptions,
  service: TaskboardService,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  scope: TaskboardActionScope,
): Promise<Record<string, unknown>> {
  const taskId = requireField(input.id, 'id');
  const current = await service.getTask(identity, taskId);
  const attachments = await resolveTaskboardAttachments(options, identity, input.attachments);
  const patch = taskPatch(input, attachments);
  const task = await service.updateTask(identity, taskId, { ...patch, expectedVersion: current.version });
  await markTaskboardAttachments(options, identity, attachments, scope);
  return { updated: true, task };
}

async function moveLegacyTask(
  service: TaskboardService,
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
  execution: TaskboardExecutionContext | undefined,
): Promise<Record<string, unknown>> {
  if (execution) {
    if (execution.execution.protocolVersion === 2) {
      throw new Error('当前 Execution 必须通过结构化 resolution 提交阶段结果');
    }
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

function taskPatch(
  input: TaskboardManageInput,
  attachments?: TaskBoardUploadAttachment[],
): Omit<TaskBoardTaskPatchInput, 'expectedVersion'> {
  const patch: Omit<TaskBoardTaskPatchInput, 'expectedVersion'> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.branch !== undefined) patch.branch = input.branch;
  if (attachments !== undefined) patch.attachments = attachments;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
  if (input.model !== undefined) patch.model = input.model;
  if (Object.keys(patch).length === 0) throw new Error(`${input.action} 至少需要一个任务字段`);
  return patch;
}

async function resolveTaskboardAttachments(
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  attachments: TaskboardAttachmentInput[] | undefined,
): Promise<TaskBoardUploadAttachment[] | undefined> {
  if (attachments === undefined) return undefined;
  if (attachments.length === 0) return [];
  if (!options.resolveAttachments) {
    throw new TaskboardValidationError(
      'Taskboard attachment resolver is unavailable',
      'TASKBOARD_ATTACHMENT_UNAVAILABLE',
    );
  }
  try {
    const resolved = await options.resolveAttachments(
      identity,
      attachments.map((attachment) => attachment.attachmentId),
    );
    if (resolved.length !== attachments.length || resolved.some(
      (attachment, index) => attachment.attachmentId !== attachments[index]!.attachmentId,
    )) {
      throw new Error('Attachment resolver returned an unexpected attachment set');
    }
    return resolved;
  } catch (error) {
    if (error instanceof TaskboardValidationError) throw error;
    throw new TaskboardValidationError(
      error instanceof Error ? error.message : 'Invalid attachment',
      'TASKBOARD_INVALID_ATTACHMENT',
    );
  }
}

async function markTaskboardAttachments(
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  attachments: TaskBoardUploadAttachment[] | undefined,
  scope: TaskboardActionScope,
): Promise<void> {
  if (!attachments?.length) return;
  if (!options.markAttachmentsReferenced) {
    throw new TaskboardValidationError(
      'Taskboard attachment reference service is unavailable',
      'TASKBOARD_ATTACHMENT_UNAVAILABLE',
    );
  }
  try {
    await options.markAttachmentsReferenced(identity, attachments, {
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    });
  } catch (error) {
    if (error instanceof TaskboardValidationError) throw error;
    throw new TaskboardValidationError(
      error instanceof Error ? error.message : 'Failed to reference attachment',
      'TASKBOARD_ATTACHMENT_REFERENCE_FAILED',
    );
  }
}

async function assertCanDispatch(
  service: TaskboardService,
  identity: TaskboardIdentity,
  boardId: string,
): Promise<void> {
  const board = await service.getBoard(identity, boardId);
  if (!(board.allowedActions?.includes('execution.trigger') ?? board.canManage)) {
    throw new TaskboardPermissionError('Taskboard role does not allow Agent execution');
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
