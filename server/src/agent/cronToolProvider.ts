import { z } from 'zod';

import {
  TASKBOARD_EXECUTION_PURPOSES,
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  TASKBOARD_VISIBILITIES,
} from '../../../shared/src/types/taskboard.js';
import type { CronService } from '../cron/service.js';
import { validateCronExpr } from '../cron/scheduler.js';
import {
  cronJobCreateSchema,
  cronJobPatchSchema,
  cronPayloadPatchSchema,
  cronPayloadSchema,
  cronScheduleSchema,
  notifyConfigSchema,
  type CronJob,
} from '../cron/types.js';
import {
  invokeTaskboardAction,
  TASKBOARD_MANAGE_ACTIONS,
  TASKBOARD_READ_ACTIONS,
  type TaskboardManageInput,
  type TaskboardToolOptions,
} from './taskboardToolActions.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
  ExecutionInvocationAudit,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

/**
 * 内置定时任务工具（CronManage，单工具）。
 *
 * 背景：skills-pool 的 cron skill 原指示模型调用 `mcp__cron__manage`——那是
 * 本机 harness 专属 MCP 工具，agent-saas 运行时不存在，模型会陷入找工具迷航
 * （实证：会话 b690311a，2026-07-03）。本 provider 把现成的 CronService 以
 * 内置工具形态暴露给 agent，语义与 REST 路由 routes/cron.ts 对齐：
 * - owner 一律取会话归属者（sessionOwner 优先，兼容 scheduler wake 路径），
 *   所有读写只作用于 owner 自己的任务，与 REST `canAccess` 相同。
 * - create/update 复用 cronJobCreateSchema / cronJobPatchSchema，字段校验
 *   与 REST 完全一致。
 *
 * 2026-08-03 工具面收敛批次：原 CronList 并入本工具的 action="list"。
 * 静态 risk 保持 dangerous（最高档），resolveCallPolicy 对 list 降为 safe，
 * 免审批语义与原 CronList（safe/never）完全一致。
 */

type CronManageInput = TaskboardManageInput & {
  action: string;
  target?: 'cron' | 'taskboard';
  name?: string;
  enabled?: boolean;
  schedule?: unknown;
  payload?: unknown;
  notify?: unknown;
};

const CRON_MANAGE_ACTIONS = ['delete', 'run', ...TASKBOARD_MANAGE_ACTIONS] as const;

const dateTimeSchema = z.string().datetime({ offset: true });
const cronManageSchema = z.object({
  target: z.enum(['cron', 'taskboard']).optional().describe('操作对象。默认 cron；taskboard 由服务端按当前用户与租户鉴权。'),
  action: z.enum(CRON_MANAGE_ACTIONS).describe('cron 支持 list/create/update/delete/run；taskboard 支持 board/task/comment/execution 资源 action。Work/Review 必须用 execution.pull_request.inspect 读取当前 head 的权威 CI；Merge 使用 integration.source.inspect。Integration Work 单父 commit 后须调用 execution.integration_candidate.push；正常修复以当前 head 为父，基线漂移重建以冻结 base 为父，且不得自行 git push。'),
  id: z.string().optional().describe('cron job、旧 taskboard 任务或评论 id。'),
  boardId: z.string().optional().describe('taskboard 看板 id。'),
  taskId: z.string().optional().describe('taskboard 任务 id。'),
  sourceId: z.string().optional().describe('taskboard integration source id。'),
  providerPullRequestId: z.string().optional().describe('仓库 Provider 的 pull request id 或编号。'),
  inspectionId: z.string().uuid().optional().describe('execution.pull_request.inspect 返回的受控快照 id。'),
  providerJobId: z.string().regex(/^\d+$/).optional().describe('当前 inspection receipt 中的 GitHub Actions job id。'),
  kind: z.enum(['delivery', 'advisory', 'integration', 'remediation']).optional(),
  name: z.string().trim().min(1).max(120).optional().describe('cron 或 taskboard 看板名称。'),
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().max(20_000).optional(),
  prompt: z.string().max(20_000).optional(),
  visibility: z.enum(TASKBOARD_VISIBILITIES).optional(),
  body: z.string().trim().max(20_000).optional().describe('评论正文；comment.create 可仅提交附件。'),
  reason: z.string().trim().min(1).max(2_000).optional().describe('取消集成任务的原因。'),
  enabled: z.boolean().optional().describe('cron 是否启用。create 时默认 true。'),
  schedule: cronScheduleSchema.optional().describe('cron create 必填。kind=cron：{expr: "0 9 * * *", tz: "Asia/Shanghai"}；kind=every：{everyMs}；kind=at：{atMs: epoch 毫秒}。'),
  payload: z.union([cronPayloadSchema, cronPayloadPatchSchema]).optional().describe('cron create 必填。kind=agentTurn：{message}；kind=systemEvent：{text}。'),
  notify: notifyConfigSchema.optional().describe('cron 完成后的结果推送配置。'),
  branch: z.string().trim().min(1).max(512).nullable().optional(),
  status: z.enum(TASKBOARD_STATUSES).optional(),
  statuses: z.array(z.enum(TASKBOARD_STATUSES)).max(TASKBOARD_STATUSES.length).optional(),
  priority: z.enum(TASKBOARD_PRIORITIES).optional(),
  priorities: z.array(z.enum(TASKBOARD_PRIORITIES)).max(TASKBOARD_PRIORITIES.length).optional(),
  labels: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  dueAt: dateTimeSchema.nullable().optional(),
  model: z.string().trim().min(1).max(256).nullable().optional(),
  purpose: z.enum(TASKBOARD_EXECUTION_PURPOSES).optional(),
  search: z.string().max(500).optional(),
  boardName: z.string().trim().max(120).optional(),
  creatorUserId: z.string().trim().min(1).max(128).optional(),
  createdAfter: dateTimeSchema.optional(),
  createdBefore: dateTimeSchema.optional(),
  updatedAfter: dateTimeSchema.optional(),
  updatedBefore: dateTimeSchema.optional(),
  dueAfter: dateTimeSchema.optional(),
  dueBefore: dateTimeSchema.optional(),
  includeArchived: z.boolean().optional(),
  expectedVersion: z.number().int().min(1).optional().describe('taskboard CAS 版本；资源写操作必填。'),
  previousTaskId: z.string().min(1).max(128).optional(),
  nextTaskId: z.string().min(1).max(128).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  attachments: z.array(z.object({
    attachmentId: z.string().uuid(),
  }).strict()).max(50).optional().describe('taskboard 会话附件；只提交当前会话已上传附件的 attachmentId，不要提交 relativePath；task.update/兼容 update 会追加到既有任务附件，不替换旧附件。'),
  dispatch: z.boolean().optional().describe('task.create 或兼容 create 时立即派发 work Agent。'),
  include: z.array(z.enum(['task', 'board', 'comments', 'executions', 'activity', 'integrationSources'] as const)).max(6).optional(),
  historyMode: z.enum(['auto', 'full', 'delta'] as const).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  deliveryTaskIds: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
  expectedBoardVersion: z.number().int().min(1).optional(),
  commitOid: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/).optional()
    .describe('仅 execution.integration_candidate.push 使用：Work Agent 刚创建的完整 commit OID。'),
}).strict();

export const cronManageToolDescriptor: ToolDescriptor<CronManageInput> = {
  id: 'CronManage',
  name: 'CronManage',
  displayName: 'Manage Tasks',
  description: loadToolDescription('CronManage'),
  schema: cronManageSchema,
  risk: 'dangerous',
  approvalMode: 'web',
  auditCategory: 'task.manage',
  category: 'cron',
  label: '管理任务',
  resolveCallPolicy: (input) => {
    if (!input || typeof input !== 'object') return undefined;
    const { action, target, dispatch } = input as { action?: unknown; target?: unknown; dispatch?: unknown };
    if (target !== 'taskboard' && action === 'list') return { risk: 'safe' };
    if (
      target === 'taskboard'
      && typeof action === 'string'
      && TASKBOARD_READ_ACTIONS.includes(action as (typeof TASKBOARD_READ_ACTIONS)[number])
    ) return { risk: 'safe' };
    if (
      target === 'taskboard'
      && action !== 'execute'
      && action !== 'task.dispatch'
      && action !== 'comment.delete'
      && action !== 'integration.create'
      && action !== 'execution.integration_candidate.push'
      && dispatch !== true
    ) return { risk: 'workspace_write' };
    return undefined;
  },
};

interface CronIdentity {
  id: string;
  username: string;
  role?: 'admin' | 'user';
  tenantId?: string;
  realName?: string;
}

type TaskboardExecutionLocator =
  | { kind: 'run'; id: string }
  | { kind: 'session'; id: string };

function resolveTaskboardExecutionLocator(context: ToolCallContext): TaskboardExecutionLocator | undefined {
  if (context.runId?.startsWith('taskboard-')) return { kind: 'run', id: context.runId };
  const topLevelSessionId = context.workspace.topLevelSessionId;
  if (topLevelSessionId?.startsWith('taskboard-')) return { kind: 'session', id: topLevelSessionId };
  if (context.sessionId?.startsWith('taskboard-')) return { kind: 'session', id: context.sessionId };
  return undefined;
}

/** cron 沿用会话归属者语义；taskboard 普通管理必须优先使用当前调用用户。 */
function resolveIdentity(context?: ToolCallContext, currentCallerFirst = false): CronIdentity | undefined {
  const identity = currentCallerFirst
    ? context?.channelContext?.user ?? context?.channelContext?.sessionOwner
    : context?.channelContext?.sessionOwner ?? context?.channelContext?.user;
  if (!identity?.id || !identity.username) return undefined;
  return {
    id: identity.id,
    username: identity.username,
    role: identity.role,
    tenantId: identity.tenantId,
    realName: identity.realName,
  };
}

function recordTaskboardAudit(
  context: ToolCallContext,
  identity: CronIdentity,
  input: TaskboardManageInput,
  taskboardRun: boolean,
  result?: Record<string, unknown>,
  error?: unknown,
): void {
  if (!context.executionAudit) return;
  const action = input.action;
  const objectType = action.startsWith('board.')
    ? 'board'
    : action.startsWith('comment.')
      ? 'comment'
      : action.startsWith('execution.')
        ? 'execution'
        : 'task';
  const resultResource = result?.[objectType] as { id?: unknown } | undefined;
  const objectId = action === 'execution.integration_candidate.push' && typeof result?.candidateId === 'string'
    ? result.candidateId
    : typeof resultResource?.id === 'string'
      ? resultResource.id
      : objectType === 'board'
        ? input.boardId
        : objectType === 'comment'
          ? input.id ?? input.taskId
          : input.taskId ?? input.id ?? input.boardId;
  const partialFailure = result?.created === true && result.dispatched === false;
  const dispatchError = partialFailure
    ? (result?.dispatchError as { message?: unknown } | undefined)?.message
    : undefined;
  const auditError = error ?? dispatchError;
  const audit: ExecutionInvocationAudit & Record<string, unknown> = {
    provider: 'server-local',
    operation: action,
    actorUserId: identity.id,
    ...(identity.tenantId ? { tenantId: identity.tenantId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    ...(context.invocationId ? { invocationId: context.invocationId } : {}),
    objectType,
    ...(objectId ? { objectId } : {}),
    contextKind: taskboardRun ? 'taskboard_execution' : 'normal_session',
    resultStatus: partialFailure ? 'partial_success' : auditError === undefined ? 'success' : 'error',
    recordedAt: new Date().toISOString(),
    status: auditError === undefined ? 'success' : 'error',
    ...(auditError === undefined ? {} : {
      error: auditError instanceof Error ? auditError.message : String(auditError),
    }),
  };
  context.executionAudit.record(audit);
}

function toIso(ms?: number): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function summarizeJob(job: CronJob): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    ...(job.description ? { description: job.description } : {}),
    enabled: job.enabled,
    schedule: job.schedule,
    payloadKind: job.payload.kind,
    ...(job.notify ? { notify: { enabled: job.notify.enabled, channel: job.notify.channel } } : {}),
    nextRunAt: toIso(job.state.nextRunAtMs),
    lastRunAt: toIso(job.state.lastRunAtMs),
    lastStatus: job.state.lastStatus,
    ...(job.state.lastError ? { lastError: job.state.lastError } : {}),
  };
}

function jobDetail(job: CronJob): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    ...(job.description ? { description: job.description } : {}),
    enabled: job.enabled,
    schedule: job.schedule,
    payload: job.payload,
    ...(job.notify ? { notify: job.notify } : {}),
    createdAt: toIso(job.createdAtMs),
    updatedAt: toIso(job.updatedAtMs),
    state: {
      nextRunAt: toIso(job.state.nextRunAtMs),
      lastRunAt: toIso(job.state.lastRunAtMs),
      lastStatus: job.state.lastStatus,
      ...(job.state.lastError ? { lastError: job.state.lastError } : {}),
      ...(typeof job.state.lastDurationMs === 'number' ? { lastDurationMs: job.state.lastDurationMs } : {}),
    },
  };
}

export interface CronToolProviderOptions {
  /** 惰性 getter：cronRuntime 在 dispatch 构造之后才创建，取用时再解析。 */
  service: () => CronService | undefined;
  /** 同一工具中的任务看板域；PG taskboard 未启用时仅保留 cron 能力。 */
  taskboard?: TaskboardToolOptions;
}

export class CronToolProvider implements ToolProvider {
  constructor(private readonly options: CronToolProviderOptions) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    if (!this.options.service() && !this.options.taskboard?.service()) return [];
    if (!resolveIdentity(context)) return [];
    return [cronManageToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== cronManageToolDescriptor.id) return undefined;
    const input = cronManageSchema.parse(call.input ?? {}) as CronManageInput;
    const executionLocator = resolveTaskboardExecutionLocator(context);
    const taskboardExecution = executionLocator !== undefined;
    const identity = resolveIdentity(context, input.target === 'taskboard' && !taskboardExecution);
    if (!identity) throw new Error('缺少当前用户身份，无法访问任务');
    if (taskboardExecution && input.target !== 'taskboard') {
      throw new Error('任务看板 Agent 只能使用 target=taskboard');
    }
    if (input.target === 'taskboard') {
      if (!this.options.taskboard) throw new Error('任务看板服务未启用');
      const tenantId = identity.tenantId?.trim();
      if (!tenantId) throw new Error('缺少当前用户组织身份，无法访问任务看板');
      try {
        const executionStore = this.options.taskboard.executionStore?.();
        if (taskboardExecution && !executionStore) throw new Error('任务看板执行上下文服务未启用');
        const execution = executionLocator?.kind === 'run'
          ? await executionStore!.getExecutionContextByRunId(executionLocator.id)
          : executionLocator?.kind === 'session'
            ? await executionStore!.getExecutionContextBySessionId(executionLocator.id)
            : null;
        if (taskboardExecution && !execution) throw new Error('任务看板执行上下文不存在');
        const taskboardIdentity = {
          tenantId,
          ownerUserId: identity.id,
          username: identity.username,
          ...(identity.realName ? { displayName: `${identity.realName} @${identity.username}` } : {}),
          ...(identity.role ? { userRole: identity.role } : {}),
        };
        const trustedWorkspace = input.action === 'execution.integration_candidate.push'
          ? await this.options.taskboard.resolveTrustedWorkspace?.(taskboardIdentity, {
              ...(context.workspace.id ? { id: context.workspace.id } : {}),
              executionTarget: context.workspace.executionTarget,
            })
          : undefined;
        const result = await invokeTaskboardAction(this.options.taskboard, taskboardIdentity, input, {
          ...(execution ? { execution } : {}),
          ...(trustedWorkspace ? { trustedWorkspace } : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        });
        recordTaskboardAudit(context, identity, input, taskboardExecution, result);
        return { content: JSON.stringify(result, null, 2) };
      } catch (error) {
        recordTaskboardAudit(context, identity, input, taskboardExecution, undefined, error);
        throw error;
      }
    }

    const service = this.options.service();
    if (!service) throw new Error('定时任务服务未启用');
    if (input.action === 'list') return this.query(service, identity, input);
    return this.manage(service, identity, input);
  }

  private async query(service: CronService, identity: CronIdentity, input: CronManageInput): Promise<ToolResult> {
    if (input.id) {
      const job = await this.getOwnedJob(service, identity, input.id);
      return { content: JSON.stringify(jobDetail(job), null, 2) };
    }
    const jobs = (await service.list({ includeDisabled: true }))
      // 平台系统任务（memory_poll 等）不进模型可见列表——CronManage 对它们
      // 一律拒绝，展示只会诱导无效操作浪费轮次
      .filter((job) => job.owner === identity.id && !job.systemKind);
    return {
      content: JSON.stringify({ count: jobs.length, jobs: jobs.map(summarizeJob) }, null, 2),
    };
  }

  private async manage(service: CronService, identity: CronIdentity, input: CronManageInput): Promise<ToolResult> {
    switch (input.action) {
      case 'create': {
        const create = cronJobCreateSchema.parse({
          name: input.name,
          description: input.description,
          enabled: input.enabled,
          schedule: input.schedule,
          payload: input.payload,
          notify: input.notify,
        });
        if (create.schedule.kind === 'cron') {
          const check = validateCronExpr(create.schedule.expr, create.schedule.tz);
          if (!check.valid) throw new Error(`无效的 cron 表达式: ${check.error}`);
        }
        const job = await service.add(create, { owner: identity.id, ownerName: identity.username });
        return { content: JSON.stringify({ created: true, job: jobDetail(job) }, null, 2) };
      }
      case 'update': {
        const target = await this.getOwnedJob(service, identity, this.requireId(input));
        const patch = cronJobPatchSchema.parse({
          name: input.name,
          description: input.description,
          enabled: input.enabled,
          schedule: input.schedule,
          payload: input.payload,
          notify: input.notify,
        });
        if (patch.schedule?.kind === 'cron') {
          const check = validateCronExpr(patch.schedule.expr, patch.schedule.tz);
          if (!check.valid) throw new Error(`无效的 cron 表达式: ${check.error}`);
        }
        const updated = await service.update(target.id, patch);
        if (!updated) throw new Error(`定时任务不存在: ${target.id}`);
        return { content: JSON.stringify({ updated: true, job: jobDetail(updated) }, null, 2) };
      }
      case 'delete': {
        const target = await this.getOwnedJob(service, identity, this.requireId(input));
        const removed = await service.remove(target.id);
        return { content: JSON.stringify({ deleted: removed, id: target.id }, null, 2) };
      }
      case 'run': {
        const target = await this.getOwnedJob(service, identity, this.requireId(input));
        const result = await service.runNow(target.id);
        return { content: JSON.stringify({ ran: result.ran, ...(result.error ? { error: result.error } : {}), id: target.id }, null, 2) };
      }
      default:
        throw new Error(`未知 action: ${String(input.action)}`);
    }
  }

  private requireId(input: CronManageInput): string {
    const id = input.id?.trim();
    if (!id) throw new Error(`action=${input.action} 需要提供 id`);
    return id;
  }

  private async getOwnedJob(service: CronService, identity: CronIdentity, id: string): Promise<CronJob> {
    const job = await service.get(id);
    // 不区分「不存在」与「非本人任务」，避免探测他人任务 id。
    if (!job || job.owner !== identity.id) throw new Error(`定时任务不存在: ${id}`);
    return job;
  }
}
