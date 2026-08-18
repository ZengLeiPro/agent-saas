import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import type { UserStore } from '../data/users/store.js';
import type { UploadManager } from '../uploads/manager.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import {
  TASKBOARD_EXECUTION_PURPOSES,
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  TASKBOARD_TASK_KINDS,
  TASKBOARD_VISIBILITIES,
  type TaskBoardAttachment,
  type TaskBoardUploadAttachment,
} from '../../../shared/src/types/taskboard.js';
import {
  TaskboardConflictError,
  TaskboardExecutionUnavailableError,
  TaskboardNotFoundError,
  TaskboardPermissionError,
  TaskboardValidationError,
  type TaskboardExecutionService,
  type TaskboardIdentity,
  type TaskboardService,
} from '../taskboard/types.js';

const repositorySchema = z.object({
  provider: z.literal('github'),
  repositoryId: z.string().trim().min(1).max(256),
  owner: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(128),
  baseBranch: z.string().trim().min(1).max(256),
  allowForkPullRequest: z.literal(false),
}).strict();

const integrationTriggerSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('scheduled'),
    cron: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    mode: z.literal('on_ready'),
    debounceMs: z.number().int().min(0).max(86_400_000),
  }).strict(),
  z.object({
    mode: z.literal('manual'),
    allowedRoles: z.array(z.enum(['maintainer', 'owner'] as const)).min(1).max(2),
  }).strict(),
]);

const integrationPolicySchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  revision: z.string().trim().max(128).default('server'),
  trigger: integrationTriggerSchema,
  batch: z.object({
    maxTasks: z.number().int().min(1).max(100),
    selection: z.literal('priority_then_ready_at'),
  }).strict(),
  execution: z.object({
    mergeMethod: z.enum(['merge', 'squash', 'rebase'] as const),
    continueIndependentSources: z.literal(true),
    autoResolveConflicts: z.literal(true),
    maxAutomaticRemediationRounds: z.number().int().min(0).max(20),
    maxTransientRetries: z.number().int().min(0).max(20),
    requireGreenChecks: z.literal(true),
    deleteRemoteBranch: z.literal(false),
    deploy: z.literal(false),
  }).strict(),
}).strict();

const boardStageModelsSchema = z.object({
  work: z.string().trim().min(1).max(256).optional(),
  review: z.string().trim().min(1).max(256).optional(),
  merge: z.string().trim().min(1).max(256).optional(),
}).strict();

const stagePromptsSchema = z.object({
  work: z.string().trim().max(20_000).optional(),
  review: z.string().trim().max(20_000).optional(),
  merge: z.string().trim().max(20_000).optional(),
}).strict();

const boardCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4_000).optional(),
  prompt: z.string().max(20_000).optional(),
  stagePrompts: stagePromptsSchema.optional(),
  model: z.string().trim().min(1).max(256).optional(),
  stageModels: boardStageModelsSchema.optional(),
  visibility: z.enum(TASKBOARD_VISIBILITIES).optional(),
  repository: repositorySchema.optional(),
  integrationPolicy: integrationPolicySchema.optional(),
}).strict();

const boardPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4_000).optional(),
  prompt: z.string().max(20_000).optional(),
  stagePrompts: stagePromptsSchema.nullish(),
  model: z.string().trim().min(1).max(256).nullish(),
  stageModels: boardStageModelsSchema.nullish(),
  visibility: z.enum(TASKBOARD_VISIBILITIES).optional(),
  repository: repositorySchema.nullish(),
  integrationPolicy: integrationPolicySchema.nullish(),
  expectedVersion: z.number().int().min(1),
}).strict().refine(
  (input) => input.name !== undefined || input.description !== undefined
    || input.prompt !== undefined || input.model !== undefined
    || input.stageModels !== undefined || input.stagePrompts !== undefined
    || input.visibility !== undefined || input.repository !== undefined || input.integrationPolicy !== undefined,
  { message: 'At least one board field is required' },
);

const expectedVersionSchema = z.object({
  expectedVersion: z.number().int().min(1),
}).strict();

const executionStartSchema = z.object({
  expectedVersion: z.number().int().min(1),
  purpose: z.enum(TASKBOARD_EXECUTION_PURPOSES).optional(),
}).strict();

const labelsSchema = z.array(z.string().trim().min(1).max(64)).max(20)
  .transform((labels) => [...new Set(labels)]);
const dueAtSchema = z.string().datetime({ offset: true });
const attachmentSchema = z.object({
  attachmentId: z.string().uuid(),
  originalName: z.string().min(1).max(512),
  relativePath: z.string().min(1).max(2_000),
  size: z.number().int().min(0),
  mimeType: z.string().min(1).max(256),
  isImage: z.boolean(),
}).strict();
const attachmentsSchema = z.array(attachmentSchema).max(50);

const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(20_000).optional(),
  kind: z.enum(['delivery', 'advisory']).optional(),
  branch: z.string().trim().min(1).max(512).optional(),
  attachments: attachmentsSchema.optional(),
  status: z.enum(TASKBOARD_STATUSES).optional(),
  priority: z.enum(TASKBOARD_PRIORITIES).optional(),
  labels: labelsSchema.optional(),
  dueAt: dueAtSchema.optional(),
  model: z.string().trim().min(1).max(256).optional(),
  clientRequestId: z.string().trim().min(1).max(128).optional(),
  dispatch: z.boolean().optional(),
}).strict().superRefine((input, context) => {
  if (input.dispatch && input.status !== 'in_progress') {
    context.addIssue({ code: 'custom', message: 'dispatch requires in_progress status', path: ['dispatch'] });
  }
  if (!input.dispatch && input.status && !['backlog', 'todo'].includes(input.status)) {
    context.addIssue({ code: 'custom', message: 'initial status must be backlog or todo', path: ['status'] });
  }
  if (input.dispatch && !input.clientRequestId) {
    context.addIssue({ code: 'custom', message: 'dispatch requires clientRequestId', path: ['clientRequestId'] });
  }
});

const taskPatchSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().max(20_000).optional(),
  kind: z.literal('delivery').optional(),
  branch: z.string().trim().min(1).max(512).nullish(),
  attachments: attachmentsSchema.optional(),
  priority: z.enum(TASKBOARD_PRIORITIES).optional(),
  labels: labelsSchema.optional(),
  dueAt: dueAtSchema.nullable().optional(),
  model: z.string().trim().min(1).max(256).nullish(),
  expectedVersion: z.number().int().min(1),
}).strict().refine(
  (input) => input.title !== undefined
    || input.description !== undefined
    || input.kind !== undefined
    || input.branch !== undefined
    || input.attachments !== undefined
    || input.priority !== undefined
    || input.labels !== undefined
    || input.dueAt !== undefined
    || input.model !== undefined,
  { message: 'At least one task field is required' },
);

const taskMoveSchema = z.object({
  status: z.enum(TASKBOARD_STATUSES),
  previousTaskId: z.string().min(1).max(128).optional(),
  nextTaskId: z.string().min(1).max(128).optional(),
  expectedVersion: z.number().int().min(1),
}).strict();

const commentCreateSchema = z.object({
  body: z.string().trim().max(20_000).default(''),
  attachments: attachmentsSchema.optional(),
}).strict().refine(
  (input) => input.body.length > 0 || Boolean(input.attachments?.length),
  { message: 'Comment body or attachment is required' },
);

const commentPatchSchema = z.object({
  body: z.string().trim().max(20_000),
  expectedVersion: z.number().int().min(1),
}).strict();

const memberPatchSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  role: z.enum(['viewer', 'editor', 'maintainer'] as const),
}).strict();

const integrationBatchSchema = z.object({
  deliveryTaskIds: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
  expectedBoardVersion: z.number().int().min(1),
}).strict();

const integrationCancelSchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(1).max(2_000).optional(),
}).strict();

const taskResumeSchema = z.object({
  expectedVersion: z.number().int().min(1),
  decision: z.string().trim().min(1).max(2_000),
  sourceIds: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
}).strict();

const executionContextSchema = z.object({
  include: z.array(z.enum(['task', 'board', 'comments', 'executions', 'activity', 'integrationSources'] as const))
    .max(6).optional(),
  history: z.object({
    mode: z.enum(['auto', 'full', 'delta'] as const),
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).strict().optional(),
}).strict();

const pageQueryFields = {
  page: numberQuerySchema(1, 1_000_000, 1),
  pageSize: numberQuerySchema(1, 100, 20),
};

const paginationQuerySchema = z.object(pageQueryFields).strict();

const boardsQuerySchema = z.object({
  includeArchived: booleanQuerySchema(),
}).strict();

const boardSearchQuerySchema = z.object({
  includeArchived: booleanQuerySchema(),
  search: z.string().trim().max(240).optional(),
  ...pageQueryFields,
}).strict();

const tasksQuerySchema = z.object({
  includeArchived: booleanQuerySchema(),
  search: z.string().trim().max(500).optional(),
  status: enumListQuerySchema(TASKBOARD_STATUSES),
  kind: enumListQuerySchema(TASKBOARD_TASK_KINDS),
  priority: enumListQuerySchema(TASKBOARD_PRIORITIES),
}).strict();

const taskSearchQuerySchema = z.object({
  boardId: z.string().trim().min(1).max(128).optional(),
  boardName: z.string().trim().max(120).optional(),
  includeArchived: booleanQuerySchema(),
  search: z.string().trim().max(500).optional(),
  status: enumListQuerySchema(TASKBOARD_STATUSES),
  kind: enumListQuerySchema(TASKBOARD_TASK_KINDS),
  priority: enumListQuerySchema(TASKBOARD_PRIORITIES),
  labels: stringListQuerySchema(20),
  creatorUserId: z.string().trim().min(1).max(128).optional(),
  createdAfter: dueAtSchema.optional(),
  createdBefore: dueAtSchema.optional(),
  updatedAfter: dueAtSchema.optional(),
  updatedBefore: dueAtSchema.optional(),
  dueAfter: dueAtSchema.optional(),
  dueBefore: dueAtSchema.optional(),
  ...pageQueryFields,
}).strict();

export interface TaskboardRouterOptions {
  service?: TaskboardService;
  executionService?: TaskboardExecutionService;
  /** 用于解析评论/执行提示词中的用户展示名（如「曾磊 @zenglei」）。 */
  userStore?: UserStore;
  /** 将上传暂存附件解析为当前用户工作区中的可信附件。 */
  agentCwd?: string;
  uploadManager?: UploadManager;
}

export function createTaskboardRouter(options: TaskboardRouterOptions): Router {
  const router = Router();
  const identityFrom = identityFactory(options);

  router.use((req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required', code: 'TASKBOARD_AUTH_REQUIRED' });
      return;
    }
    if (!options.service) {
      res.status(503).json({ error: 'Taskboard service unavailable', code: 'TASKBOARD_UNAVAILABLE' });
      return;
    }
    next();
  });

  router.get('/boards', route(async (req, res) => {
    const query = parseOrReply(boardsQuerySchema, req.query, res, 'query');
    if (!query) return;
    res.json(await options.service!.listBoards(identityFrom(req), query.includeArchived));
  }));

  router.get('/boards/search', route(async (req, res) => {
    const query = parseOrReply(boardSearchQuerySchema, req.query, res, 'query');
    if (!query) return;
    res.json(await options.service!.searchBoards(identityFrom(req), query));
  }));

  router.post('/boards', route(async (req, res) => {
    const input = parseOrReply(boardCreateSchema, req.body, res, 'body');
    if (!input) return;
    res.status(201).json(await options.service!.createBoard(identityFrom(req), input));
  }));

  router.get('/boards/:id', route(async (req, res) => {
    res.json(await options.service!.getBoard(identityFrom(req), req.params.id));
  }));

  router.patch('/boards/:id', route(async (req, res) => {
    const input = parseOrReply(boardPatchSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.updateBoard(identityFrom(req), req.params.id, input));
  }));

  router.post('/boards/:id/archive', route(async (req, res) => {
    const input = parseOrReply(expectedVersionSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.archiveBoard(identityFrom(req), req.params.id, input));
  }));

  router.post('/boards/:id/restore', route(async (req, res) => {
    const input = parseOrReply(expectedVersionSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.restoreBoard(identityFrom(req), req.params.id, input));
  }));

  router.get('/boards/:id/members', route(async (req, res) => {
    if (!options.service!.listMembers) throw new TaskboardExecutionUnavailableError();
    res.json(await options.service!.listMembers(identityFrom(req), req.params.id));
  }));

  router.put('/boards/:id/members', route(async (req, res) => {
    if (!options.service!.upsertMember) throw new TaskboardExecutionUnavailableError();
    const input = parseOrReply(memberPatchSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.upsertMember(identityFrom(req), req.params.id, input));
  }));

  router.delete('/boards/:id/members/:userId', route(async (req, res) => {
    if (!options.service!.removeMember) throw new TaskboardExecutionUnavailableError();
    await options.service!.removeMember(identityFrom(req), req.params.id, req.params.userId);
    res.status(204).end();
  }));

  router.post('/boards/:id/integrations', route(async (req, res) => {
    if (!options.service!.createIntegrationBatch || !options.executionService) {
      throw new TaskboardExecutionUnavailableError();
    }
    const input = parseOrReply(integrationBatchSchema, req.body, res, 'body');
    if (!input) return;
    const identity = identityFrom(req);
    const task = await options.service!.createIntegrationBatch(
      identity,
      req.params.id,
      input,
      'manual_batch',
    );
    res.status(202).json(await options.executionService.startExecution(identity, task.id, {
      expectedVersion: task.version,
      purpose: 'merge',
    }));
  }));

  router.get('/boards/:boardId/tasks', route(async (req, res) => {
    const query = parseOrReply(tasksQuerySchema, req.query, res, 'query');
    if (!query) return;
    res.json(await options.service!.listTasks(identityFrom(req), req.params.boardId, {
      includeArchived: query.includeArchived,
      ...(query.search ? { search: query.search } : {}),
      ...(query.status?.length ? { statuses: query.status } : {}),
      ...(query.kind?.length ? { kinds: query.kind } : {}),
      ...(query.priority?.length ? { priorities: query.priority } : {}),
    }));
  }));

  router.post('/boards/:boardId/tasks', route(async (req, res) => {
    const input = parseOrReply(taskCreateSchema, req.body, res, 'body');
    if (!input) return;
    if (input.dispatch && !options.executionService?.startDirectExecution) {
      throw new TaskboardExecutionUnavailableError();
    }
    const attachments = await resolveRequestAttachments(options, req, input.attachments);
    const { dispatch, ...taskInput } = input;
    let task = await options.service!.createTask(identityFrom(req), req.params.boardId, {
      ...taskInput,
      ...(attachments ? { attachments } : {}),
    });
    await markRequestAttachments(options, req, attachments);
    if (dispatch) {
      task = (await options.executionService!.startDirectExecution!(
        identityFrom(req),
        task.id,
        task.version,
      )).task;
    }
    res.status(201).json(task);
  }));

  router.get('/tasks/search', route(async (req, res) => {
    const query = parseOrReply(taskSearchQuerySchema, req.query, res, 'query');
    if (!query) return;
    res.json(await options.service!.searchTasks(identityFrom(req), {
      boardId: query.boardId,
      boardName: query.boardName,
      includeArchived: query.includeArchived,
      search: query.search,
      statuses: query.status,
      kinds: query.kind,
      priorities: query.priority,
      labels: query.labels,
      creatorUserId: query.creatorUserId,
      createdAfter: query.createdAfter,
      createdBefore: query.createdBefore,
      updatedAfter: query.updatedAfter,
      updatedBefore: query.updatedBefore,
      dueAfter: query.dueAfter,
      dueBefore: query.dueBefore,
      page: query.page,
      pageSize: query.pageSize,
    }));
  }));

  router.get('/tasks/:id', route(async (req, res) => {
    res.json(await options.service!.getTask(identityFrom(req), req.params.id));
  }));

  router.patch('/tasks/:id', route(async (req, res) => {
    const input = parseOrReply(taskPatchSchema, req.body, res, 'body');
    if (!input) return;
    const attachments = await resolveRequestAttachments(options, req, input.attachments);
    const task = await options.service!.updateTask(identityFrom(req), req.params.id, {
      ...input,
      ...(attachments ? { attachments } : {}),
    });
    await markRequestAttachments(options, req, attachments);
    res.json(task);
  }));

  router.post('/tasks/:id/move', route(async (req, res) => {
    const input = parseOrReply(taskMoveSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.moveTask(identityFrom(req), req.params.id, input));
  }));

  router.post('/tasks/:id/archive', route(async (req, res) => {
    const input = parseOrReply(expectedVersionSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.archiveTask(identityFrom(req), req.params.id, input));
  }));

  router.post('/tasks/:id/restore', route(async (req, res) => {
    const input = parseOrReply(expectedVersionSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.restoreTask(identityFrom(req), req.params.id, input));
  }));

  router.delete('/tasks/:id', route(async (req, res) => {
    const input = parseOrReply(expectedVersionSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.deleteTask(identityFrom(req), req.params.id, input));
  }));

  router.get('/tasks/:id/executions', route(async (req, res) => {
    if (!options.executionService) {
      res.status(503).json({
        error: 'Taskboard Agent execution unavailable',
        code: 'TASKBOARD_EXECUTION_UNAVAILABLE',
      });
      return;
    }
    if (req.query.page !== undefined || req.query.pageSize !== undefined) {
      const query = parseOrReply(paginationQuerySchema, req.query, res, 'query');
      if (!query) return;
      res.json(await options.executionService.searchExecutions(identityFrom(req), req.params.id, query));
      return;
    }
    res.json(await options.executionService.listExecutions(identityFrom(req), req.params.id));
  }));

  router.post('/tasks/:id/execute', route(async (req, res) => {
    if (!options.executionService) {
      res.status(503).json({
        error: 'Taskboard Agent execution unavailable',
        code: 'TASKBOARD_EXECUTION_UNAVAILABLE',
      });
      return;
    }
    const input = parseOrReply(executionStartSchema, req.body, res, 'body');
    if (!input) return;
    res.status(202).json(await options.executionService.startExecution(
      identityFrom(req),
      req.params.id,
      input,
    ));
  }));

  router.post('/tasks/:id/context', route(async (req, res) => {
    if (!options.service!.getExecutionContextV2) throw new TaskboardExecutionUnavailableError();
    const input = parseOrReply(executionContextSchema, req.body ?? {}, res, 'body');
    if (!input) return;
    res.json(await options.service!.getExecutionContextV2(identityFrom(req), req.params.id, input));
  }));

  router.post('/tasks/:id/resume', route(async (req, res) => {
    if (!options.service!.resumeBlockedTask) throw new TaskboardExecutionUnavailableError();
    const input = parseOrReply(taskResumeSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.resumeBlockedTask(identityFrom(req), req.params.id, input));
  }));

  router.post('/tasks/:id/integration-cancel', route(async (req, res) => {
    if (!options.service!.cancelIntegrationTask) throw new TaskboardExecutionUnavailableError();
    const input = parseOrReply(integrationCancelSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.cancelIntegrationTask(identityFrom(req), req.params.id, input));
  }));

  router.get('/tasks/:id/integration-sources', route(async (req, res) => {
    if (!options.service!.listIntegrationSources) throw new TaskboardExecutionUnavailableError();
    res.json(await options.service!.listIntegrationSources(identityFrom(req), req.params.id));
  }));

  router.get('/tasks/:id/comments', route(async (req, res) => {
    if (req.query.page !== undefined || req.query.pageSize !== undefined) {
      const query = parseOrReply(paginationQuerySchema, req.query, res, 'query');
      if (!query) return;
      res.json(await options.service!.searchComments(identityFrom(req), req.params.id, query));
      return;
    }
    res.json(await options.service!.listComments(identityFrom(req), req.params.id));
  }));

  router.post('/tasks/:id/comments', route(async (req, res) => {
    const input = parseOrReply(commentCreateSchema, req.body, res, 'body');
    if (!input) return;
    const attachments = await resolveRequestAttachments(options, req, input.attachments);
    const comment = await options.service!.createComment(identityFrom(req), req.params.id, {
      ...input,
      ...(attachments ? { attachments } : {}),
    });
    await markRequestAttachments(options, req, attachments);
    res.status(201).json(comment);
  }));

  router.post('/tasks/:id/comments/:commentId/execute', route(async (req, res) => {
    if (!options.executionService?.continueExecution) {
      throw new TaskboardExecutionUnavailableError();
    }
    res.status(202).json(await options.executionService.continueExecution(
      identityFrom(req),
      req.params.id,
      req.params.commentId,
    ));
  }));

  router.patch('/comments/:id', route(async (req, res) => {
    const input = parseOrReply(commentPatchSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.updateComment(identityFrom(req), req.params.id, input));
  }));

  router.delete('/comments/:id', route(async (req, res) => {
    const input = parseOrReply(expectedVersionSchema, req.body, res, 'body');
    if (!input) return;
    res.json(await options.service!.deleteComment(identityFrom(req), req.params.id, input));
  }));

  return router;
}

async function resolveRequestAttachments(
  options: TaskboardRouterOptions,
  req: Request,
  attachments: z.output<typeof attachmentsSchema> | undefined,
): Promise<TaskBoardUploadAttachment[] | undefined> {
  if (attachments === undefined) return undefined;
  if (attachments.length === 0) return [];
  const userCwd = requestUserCwd(options, req);
  try {
    const resolved = await options.uploadManager!.resolveAttachments(
      userCwd,
      attachments.map((attachment) => attachment.attachmentId),
    );
    return resolved.map((attachment, index) => ({
      ...attachment,
      attachmentId: attachment.attachmentId ?? attachments[index]!.attachmentId,
    }));
  } catch (error) {
    throw new TaskboardValidationError(
      error instanceof Error ? error.message : 'Invalid attachment',
      'TASKBOARD_INVALID_ATTACHMENT',
    );
  }
}

async function markRequestAttachments(
  options: TaskboardRouterOptions,
  req: Request,
  attachments: TaskBoardAttachment[] | undefined,
): Promise<void> {
  if (!attachments?.length) return;
  await options.uploadManager!.markReferenced(requestUserCwd(options, req), attachments, {});
}

function requestUserCwd(options: TaskboardRouterOptions, req: Request): string {
  if (!options.agentCwd || !options.uploadManager || !req.user) {
    throw new TaskboardValidationError('Taskboard attachment upload unavailable');
  }
  return resolveUserCwd(options.agentCwd, {
    id: req.user.sub,
    username: req.user.username,
    role: req.user.role,
    tenantId: req.user.tenantId,
  });
}

function identityFactory(options: TaskboardRouterOptions): (req: Request) => TaskboardIdentity {
  return (req: Request) => {
    const user = req.user!;
    const realName = options.userStore?.findById(user.sub)?.realName;
    return {
      tenantId: user.tenantId,
      ownerUserId: user.sub,
      username: user.username,
      displayName: realName ? `${realName} @${user.username}` : user.username,
      userRole: user.role,
    };
  };
}

function route(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    void handler(req, res).catch((error) => sendError(res, error));
  };
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof TaskboardConflictError) {
    res.status(409).json({ error: error.message, code: error.code, current: error.current });
    return;
  }
  if (error instanceof TaskboardNotFoundError) {
    res.status(404).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof TaskboardPermissionError) {
    res.status(403).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof TaskboardValidationError) {
    res.status(400).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof TaskboardExecutionUnavailableError) {
    res.status(503).json({ error: error.message, code: error.code });
    return;
  }
  res.status(503).json({ error: 'Taskboard database unavailable', code: 'TASKBOARD_UNAVAILABLE' });
}

function parseOrReply<T extends z.ZodType>(
  schema: T,
  value: unknown,
  res: Response,
  source: 'body' | 'query',
): z.output<T> | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  res.status(400).json({
    error: `Invalid ${source}`,
    code: 'TASKBOARD_INVALID_REQUEST',
    issues: parsed.error.issues,
  });
  return null;
}

function booleanQuerySchema() {
  return z.preprocess((value) => {
    if (value === undefined) return false;
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  }, z.boolean());
}

function enumListQuerySchema<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess((value) => {
    if (value === undefined) return undefined;
    const entries = Array.isArray(value) ? value : [value];
    return entries.flatMap((entry) => typeof entry === 'string' ? entry.split(',') : [entry]);
  }, z.array(z.enum(values)).max(values.length).optional());
}

function stringListQuerySchema(max: number) {
  return z.preprocess((value) => {
    if (value === undefined) return undefined;
    const entries = Array.isArray(value) ? value : [value];
    return entries.flatMap((entry) => typeof entry === 'string' ? entry.split(',') : [entry]);
  }, z.array(z.string().trim().min(1).max(64)).max(max).optional());
}

function numberQuerySchema(min: number, max: number, fallback: number) {
  return z.preprocess((value) => {
    if (value === undefined) return fallback;
    if (typeof value === 'string' && value.trim()) return Number(value);
    return value;
  }, z.number().int().min(min).max(max));
}
