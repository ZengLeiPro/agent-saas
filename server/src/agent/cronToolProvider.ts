import { z } from 'zod';

import {
  TASKBOARD_EXECUTION_PURPOSES,
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
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
  type TaskboardManageInput,
  type TaskboardToolOptions,
} from './taskboardToolActions.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
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
  action: 'list' | 'create' | 'update' | 'delete' | 'run' | 'move' | 'execute';
  target?: 'cron' | 'taskboard';
  name?: string;
  enabled?: boolean;
  schedule?: unknown;
  payload?: unknown;
  notify?: unknown;
};

const cronManageSchema = z.object({
  target: z.enum(['cron', 'taskboard']).optional().describe('操作对象。默认 cron；taskboard 表示个人任务看板。'),
  action: z.enum(['list', 'create', 'update', 'delete', 'run', 'move', 'execute']).describe('cron 支持 list/create/update/delete/run；taskboard 支持 list/create/update/move/execute。'),
  id: z.string().optional().describe('cron job 或看板任务 id。'),
  name: z.string().min(1).optional().describe('cron create 必填。'),
  description: z.string().optional(),
  enabled: z.boolean().optional().describe('cron 是否启用。create 时默认 true。'),
  schedule: cronScheduleSchema.optional().describe('cron create 必填。kind=cron：{expr: "0 9 * * *", tz: "Asia/Shanghai"}；kind=every：{everyMs}；kind=at：{atMs: epoch 毫秒}。'),
  payload: z.union([cronPayloadSchema, cronPayloadPatchSchema]).optional().describe('cron create 必填。kind=agentTurn：{message}；kind=systemEvent：{text}。'),
  notify: notifyConfigSchema.optional().describe('cron 完成后的结果推送配置。'),
  boardId: z.string().optional().describe('taskboard create/list 任务时的看板 id。'),
  title: z.string().trim().min(1).max(240).optional().describe('taskboard create/update 的标题。'),
  branch: z.string().trim().min(1).max(512).nullable().optional().describe('taskboard 工作分支；update 传 null 清除。'),
  status: z.enum(TASKBOARD_STATUSES).optional().describe('taskboard create/move/list 的状态。'),
  priority: z.enum(TASKBOARD_PRIORITIES).optional().describe('taskboard create/update/list 的优先级。'),
  labels: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  model: z.string().trim().min(1).max(256).nullable().optional(),
  purpose: z.enum(TASKBOARD_EXECUTION_PURPOSES).optional().describe('taskboard execute 用途；in_review 默认 review，否则默认 work。'),
  search: z.string().max(240).optional().describe('taskboard list 任务关键词。'),
  includeArchived: z.boolean().optional(),
  dispatch: z.boolean().optional().describe('taskboard create 时立即派发给新的 work Agent。'),
});

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
    if (action === 'list') return { risk: 'safe' };
    if (target === 'taskboard' && action !== 'execute' && dispatch !== true) {
      return { risk: 'workspace_write' };
    }
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

/** 会话归属者优先；所有任务操作都作用于会话主人自己的资源。 */
function resolveIdentity(context?: ToolCallContext): CronIdentity | undefined {
  const identity = context?.channelContext?.sessionOwner ?? context?.channelContext?.user;
  if (!identity?.id || !identity.username) return undefined;
  return {
    id: identity.id,
    username: identity.username,
    role: identity.role,
    tenantId: identity.tenantId,
    realName: identity.realName,
  };
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
    const identity = resolveIdentity(context);
    if (!identity) throw new Error('缺少当前用户身份，无法访问任务');
    const input = cronManageSchema.parse(call.input ?? {}) as CronManageInput;
    const taskboardRun = context.runId?.startsWith('taskboard-') === true;
    if (taskboardRun && input.target !== 'taskboard') {
      throw new Error('任务看板 Agent 只能使用 target=taskboard');
    }
    const executionStore = this.options.taskboard?.executionStore?.();
    if (taskboardRun && !executionStore) throw new Error('任务看板执行上下文服务未启用');
    const execution = taskboardRun
      ? await executionStore!.getExecutionContextByRunId(context.runId!)
      : null;
    if (taskboardRun && !execution) throw new Error('任务看板执行上下文不存在');

    if (input.target === 'taskboard') {
      if (!taskboardRun) throw new Error('任务看板域只允许任务看板 Agent Execution 调用');
      if (!this.options.taskboard) throw new Error('任务看板服务未启用');
      const tenantId = identity.tenantId?.trim();
      if (!tenantId) throw new Error('缺少当前用户组织身份，无法访问任务看板');
      const result = await invokeTaskboardAction(this.options.taskboard, {
        tenantId,
        ownerUserId: identity.id,
        username: identity.username,
        ...(identity.realName ? { displayName: `${identity.realName} @${identity.username}` } : {}),
        ...(identity.role ? { userRole: identity.role } : {}),
      }, input, execution ? { execution } : {});
      return { content: JSON.stringify(result, null, 2) };
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
