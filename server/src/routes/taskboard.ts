import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import type { UserStore } from '../data/users/store.js';
import type { UploadManager } from '../uploads/manager.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import {
  TASKBOARD_EXECUTION_PURPOSES,
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  TASKBOARD_VISIBILITIES,
  type TaskBoardAttachment,
  type TaskBoardUploadAttachment,
} from '../../../shared/src/types/taskboard.js';
import {
  TaskboardConflictError,
  TaskboardExecutionUnavailableError,
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardExecutionService,
  type TaskboardIdentity,
  type TaskboardService,
} from '../taskboard/types.js';

const boardCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4_000).optional(),
  prompt: z.string().max(20_000).optional(),
  model: z.string().trim().min(1).max(256).optional(),
  visibility: z.enum(TASKBOARD_VISIBILITIES).optional(),
}).strict();

const boardPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4_000).optional(),
  prompt: z.string().max(20_000).optional(),
  model: z.string().trim().min(1).max(256).nullish(),
  visibility: z.enum(TASKBOARD_VISIBILITIES).optional(),
  expectedVersion: z.number().int().min(1),
}).strict().refine(
  (input) => input.name !== undefined || input.description !== undefined
    || input.prompt !== undefined || input.model !== undefined || input.visibility !== undefined,
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
  branch: z.string().trim().min(1).max(512).optional(),
  attachments: attachmentsSchema.optional(),
  status: z.enum(TASKBOARD_STATUSES).optional(),
  priority: z.enum(TASKBOARD_PRIORITIES).optional(),
  labels: labelsSchema.optional(),
  dueAt: dueAtSchema.optional(),
  model: z.string().trim().min(1).max(256).optional(),
}).strict();

const taskPatchSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().max(20_000).optional(),
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

const boardsQuerySchema = z.object({
  includeArchived: booleanQuerySchema(),
}).strict();

const tasksQuerySchema = z.object({
  includeArchived: booleanQuerySchema(),
  search: z.string().trim().max(500).optional(),
  status: enumListQuerySchema(TASKBOARD_STATUSES),
  priority: enumListQuerySchema(TASKBOARD_PRIORITIES),
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

  router.post('/boards', route(async (req, res) => {
    const input = parseOrReply(boardCreateSchema, req.body, res, 'body');
    if (!input) return;
    res.status(201).json(await options.service!.createBoard(identityFrom(req), input));
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

  router.get('/boards/:boardId/tasks', route(async (req, res) => {
    const query = parseOrReply(tasksQuerySchema, req.query, res, 'query');
    if (!query) return;
    res.json(await options.service!.listTasks(identityFrom(req), req.params.boardId, {
      includeArchived: query.includeArchived,
      ...(query.search ? { search: query.search } : {}),
      ...(query.status?.length ? { statuses: query.status } : {}),
      ...(query.priority?.length ? { priorities: query.priority } : {}),
    }));
  }));

  router.post('/boards/:boardId/tasks', route(async (req, res) => {
    const input = parseOrReply(taskCreateSchema, req.body, res, 'body');
    if (!input) return;
    const attachments = await resolveRequestAttachments(options, req, input.attachments);
    const task = await options.service!.createTask(identityFrom(req), req.params.boardId, {
      ...input,
      ...(attachments ? { attachments } : {}),
    });
    await markRequestAttachments(options, req, attachments);
    res.status(201).json(task);
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

  router.get('/tasks/:id/executions', route(async (req, res) => {
    if (!options.executionService) {
      res.status(503).json({
        error: 'Taskboard Agent execution unavailable',
        code: 'TASKBOARD_EXECUTION_UNAVAILABLE',
      });
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

  router.get('/tasks/:id/comments', route(async (req, res) => {
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
