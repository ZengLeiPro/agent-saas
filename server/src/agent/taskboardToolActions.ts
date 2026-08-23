import { createHash } from 'node:crypto';
import { appendTaskboardAttachments, cleanupTaskboardAttachments, materializeTaskboardAttachments, resolveTaskboardAttachments } from './taskboardAttachmentActions.js';
import { assertTaskboardExecutionScope } from './taskboardExecutionScope.js';
import { assertActiveBoard, assertBoardRole } from '../taskboard/storeHelpers.js';

import type {
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
  TaskboardIntegrationPushService,
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
  'execution.integration_candidate.push',
  'execution.pull_request.set',
  'execution.pull_request.inspect',
  'execution.pull_request.log',
  'execution.review_subject.record',
  'execution.transition',
  'integration.create',
  'integration.cancel',
  'integration.sources',
  'integration.candidate',
  'integration.source.inspect',
  'integration.source.log',
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
  'integration.candidate',
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
  inspectionId?: string;
  providerJobId?: string;
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
  reason?: string;
  deliveryTaskIds?: string[];
  expectedBoardVersion?: number;
  /** execution.integration_candidate.push 的唯一模型输入。 */
  commitOid?: string;
}
export interface TaskboardToolOptions {
  service: () => TaskboardService | undefined;
  generateTaskTitle?: (description: string, identity: TaskboardIdentity) => Promise<string | null>;
  executionService?: () => TaskboardExecutionService | undefined;
  integrationPush?: () => TaskboardIntegrationPushService | undefined;
  resolveTrustedWorkspace?: (
    identity: TaskboardIdentity,
    workspace: { id?: string; executionTarget: string },
  ) => Promise<{ id: string; root: string } | undefined>;
  /** 解析当前用户会话上传的附件 ID；不得接受模型传入的工作区路径。 */
  resolveAttachments?: (
    identity: TaskboardIdentity,
    attachmentIds: readonly string[],
    refs?: { sessionId?: string },
  ) => Promise<TaskBoardUploadAttachment[]>;
  /** 把上传附件复制到任务所属看板 owner 的任务作用域。 */
  materializeTaskAttachments?: (
    identity: TaskboardIdentity,
    taskId: string,
    ownerUserId: string,
    attachments: readonly TaskBoardUploadAttachment[],
  ) => Promise<TaskBoardUploadAttachment[]>;
  cleanupTaskAttachments?: (
    identity: TaskboardIdentity,
    taskId: string,
    ownerUserId: string,
    attachments: readonly TaskBoardUploadAttachment[],
  ) => Promise<void>;
  /** 将已提交附件标记为 referenced。 */
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
  /** 由平台 workspace resolver 绑定的 brain 本机共享 workspace；绝不取模型路径。 */
  trustedWorkspace?: { id: string; root: string };
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
  assertTaskboardExecutionScope(input, scope.execution, identity);
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
      const current = await service.getTask(identity, taskId);
      const attachments = await resolveTaskboardAttachments(options, identity, input.attachments, scope);
      const ownerUserId = (await service.getBoard(identity, current.boardId)).ownerUserId;
      const scopedAttachments = await materializeTaskboardAttachments(
        options, identity, current.id, ownerUserId, attachments,
      );
      const patch = taskPatch(input, appendTaskboardAttachments(current.attachments, scopedAttachments));
      try {
        await markTaskboardAttachments(options, identity, attachments, scope);
        const task = await service.updateTask(identity, taskId, {
          ...patch,
          expectedVersion: requireVersion(input),
        });
        return { updated: true, task };
      } catch (error) {
        await cleanupTaskboardAttachments(options, identity, current.id, ownerUserId, scopedAttachments, current.attachments);
        throw error;
      }
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
      const taskId = requireId(input, 'taskId');
      const current = await service.getTask(identity, taskId);
      const attachments = await resolveTaskboardAttachments(options, identity, input.attachments, scope);
      const ownerUserId = (await service.getBoard(identity, current.boardId)).ownerUserId;
      const scopedAttachments = await materializeTaskboardAttachments(
        options, identity, current.id, ownerUserId, attachments,
      );
      try {
        await markTaskboardAttachments(options, identity, attachments, scope);
        const comment = await service.createComment(identity, taskId, {
          body: input.body?.trim() ?? '',
          ...(scopedAttachments !== undefined ? { attachments: scopedAttachments } : {}),
        });
        return { created: true, comment };
      } catch (error) {
        await cleanupTaskboardAttachments(options, identity, current.id, ownerUserId, scopedAttachments);
        throw error;
      }
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
    case 'execution.integration_candidate.push': {
      if (!scope.execution || !scope.trustedWorkspace) {
        throw new Error('当前 Integration Work Execution 缺少受信 workspace 绑定');
      }
      const integrationPush = options.integrationPush?.();
      if (!integrationPush) throw new Error('Integration Work 受控 push 服务未启用');
      return integrationPush.pushCandidate(identity, {
        executionId: scope.execution.execution.id,
        workspaceRoot: scope.trustedWorkspace.root,
        commitOid: requireCommitOid(input.commitOid),
      });
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
    case 'execution.pull_request.inspect': {
      if (!scope.execution || !service.inspectExecutionPullRequestV2) {
        throw new Error('仅当前 work/review Execution 可以检查 pull request 与 CI');
      }
      return await service.inspectExecutionPullRequestV2(
        identity,
        scope.execution.execution.runId,
      ) as unknown as Record<string, unknown>;
    }
    case 'execution.pull_request.log': {
      if (!scope.execution || !service.readExecutionPullRequestJobLogV2) {
        throw new Error('仅当前 work/review Execution 可以读取受控 CI 失败日志');
      }
      return await service.readExecutionPullRequestJobLogV2(
        identity,
        scope.execution.execution.runId,
        requireField(input.inspectionId, 'inspectionId'),
        requireField(input.providerJobId, 'providerJobId'),
      );
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
    case 'execution.transition': {
      if (!scope.execution || !service.transitionExecutionV2) {
        throw new Error('仅当前任务 Execution 可以推进任务状态');
      }
      if (!input.status) throw new Error('execution.transition 需要 status');
      const task = await service.transitionExecutionV2(identity, scope.execution.execution.runId, { status: input.status });
      return { transitioned: true, task };
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
    case 'integration.candidate': {
      if (!service.getIntegrationCandidate) throw new Error('任务看板 Integration v3 candidate 读取服务未启用');
      const taskId = scope.execution?.task.id ?? requireId(input, 'taskId');
      return await service.getIntegrationCandidate(identity, taskId) as unknown as Record<string, unknown>;
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
    case 'integration.source.log': {
      if (!scope.execution || !service.readIntegrationSourceJobLogV2) {
        throw new Error('仅当前 merge Execution 可以读取受控 CI 失败日志');
      }
      return await service.readIntegrationSourceJobLogV2(
        identity,
        scope.execution.execution.runId,
        requireField(input.sourceId, 'sourceId'),
        requireField(input.inspectionId, 'inspectionId'),
        requireField(input.providerJobId, 'providerJobId'),
      );
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
      if (scope.execution && input.attachments === undefined) {
        return updateExecutionTask(options, identity, input, scope.execution);
      }
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
  const board = await service.getBoard(identity, boardId);
  assertBoardRole(board.role, 'editor');
  assertActiveBoard(board);
  if (input.dispatch) await assertCanDispatch(service, identity, boardId);
  if (input.dispatch && input.status && input.status !== 'todo') {
    throw new Error('dispatch=true 只支持创建 todo 任务');
  }
  const title = input.title ?? await options.generateTaskTitle?.(input.description ?? '', identity);
  const attachments = await resolveTaskboardAttachments(options, identity, input.attachments, scope);
  const ownerUserId = attachments?.length ? board.ownerUserId : undefined;
  await markTaskboardAttachments(options, identity, attachments, scope);
  const createdTask = await service.createTask(identity, boardId, {
    title: title ?? '',
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(typeof input.branch === 'string' ? { branch: input.branch } : {}),
    ...(attachments !== undefined && attachments.length === 0 ? { attachments: [] } : {}),
    status: input.dispatch ? 'todo' : input.status,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(typeof input.dueAt === 'string' ? { dueAt: input.dueAt } : {}),
    ...(typeof input.model === 'string' ? { model: input.model } : {}),
  });
  let task: TaskBoardTask = createdTask;
  let scopedAttachments: TaskBoardUploadAttachment[] | undefined;
  try {
    scopedAttachments = await materializeTaskboardAttachments(
      options, identity, createdTask.id, ownerUserId, attachments,
    );
    task = scopedAttachments
      ? await service.updateTask(identity, createdTask.id, {
        attachments: scopedAttachments,
        expectedVersion: createdTask.version,
      })
      : createdTask;
  } catch (error) {
    await rollbackCreatedTask(service, identity, createdTask, error,
      () => cleanupTaskboardAttachments(options, identity, createdTask.id, ownerUserId, scopedAttachments));
  }
  if (!input.dispatch) return { created: true, task };
  return dispatchCreatedTask(dispatcher!, identity, task);
}

async function rollbackCreatedTask(service: TaskboardService, identity: TaskboardIdentity, task: TaskBoardTask, error: unknown, cleanup?: () => Promise<void>): Promise<never> {
  try {
    await service.rollbackTaskCreation(identity, task.id, { expectedVersion: task.version }); await cleanup?.();
  } catch (cleanupError) {
    throw new TaskboardValidationError(
      `Attachment write failed and created task cleanup failed: ${error instanceof Error ? error.message : String(error)}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      'TASKBOARD_ATTACHMENT_CLEANUP_FAILED',
    );
  }
  throw error;
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
  const service = options.service();
  if (!service) throw new Error('任务看板服务未启用');
  const attachments = await resolveTaskboardAttachments(options, identity, input.attachments, scope);
  const ownerUserId = attachments?.length
    ? (await service.getBoard(identity, execution.task.boardId)).ownerUserId
    : undefined;
  await markTaskboardAttachments(options, identity, attachments, scope);
  let task = await executionStore.createTaskFromExecution(identity, execution.execution.runId, {
    title: requireField(input.title, 'title'),
    kind,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(typeof input.branch === 'string' ? { branch: input.branch } : {}),
    ...(attachments !== undefined && attachments.length === 0 ? { attachments: [] } : {}),
    status: 'todo',
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(typeof input.dueAt === 'string' ? { dueAt: input.dueAt } : {}),
    ...(typeof input.model === 'string' ? { model: input.model } : {}),
    clientRequestId: taskboardCreateRequestId(input, { execution }),
  });
  let scopedAttachments: TaskBoardUploadAttachment[] | undefined;
  try {
    scopedAttachments = await materializeTaskboardAttachments(options, identity, task.id, ownerUserId, attachments);
    if (scopedAttachments) {
      task = await service.updateTask(identity, task.id, {
        attachments: scopedAttachments,
        expectedVersion: task.version,
      });
    }
  } catch (error) {
    await rollbackCreatedTask(service, identity, task, error, () => cleanupTaskboardAttachments(options, identity, task.id, ownerUserId, scopedAttachments));
  }
  if (kind === 'remediation' && input.sourceId) {
    if (!service.linkIntegrationRemediationV2) {
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
  const attachments = await resolveTaskboardAttachments(options, identity, input.attachments, scope);
  const ownerUserId = (await service.getBoard(identity, current.boardId)).ownerUserId;
  const scopedAttachments = await materializeTaskboardAttachments(options, identity, current.id, ownerUserId, attachments);
  try {
    await markTaskboardAttachments(options, identity, attachments, scope);
    const patch = taskPatch(input, appendTaskboardAttachments(current.attachments, scopedAttachments));
    const task = await service.updateTask(identity, taskId, { ...patch, expectedVersion: current.version });
    return { updated: true, task };
  } catch (error) {
    await cleanupTaskboardAttachments(options, identity, current.id, ownerUserId, scopedAttachments, current.attachments);
    throw error;
  }
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
      throw new Error('当前 Execution 必须通过 execution.transition 指定下一状态');
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

function requireCommitOid(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(normalized)) {
    throw new Error('action 需要提供完整 commitOid');
  }
  return normalized;
}

function requireField(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`action 需要提供 ${field}`);
  return normalized;
}
