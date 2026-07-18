import { z } from 'zod';

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
import { loadToolDescription } from './tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

/**
 * 内置定时任务工具（CronList / CronManage）。
 *
 * 背景：skills-pool 的 cron skill 原指示模型调用 `mcp__cron__manage`——那是
 * 本机 harness 专属 MCP 工具，agent-saas 运行时不存在，模型会陷入找工具迷航
 * （实证：会话 b690311a，2026-07-03）。本 provider 把现成的 CronService 以
 * 内置工具形态暴露给 agent，语义与 REST 路由 routes/cron.ts 对齐：
 * - owner 一律取会话归属者（sessionOwner 优先，兼容 scheduler wake 路径），
 *   所有读写只作用于 owner 自己的任务，与 REST `canAccess` 相同。
 * - create/update 复用 cronJobCreateSchema / cronJobPatchSchema，字段校验
 *   与 REST 完全一致。
 */

type CronListInput = {
  id?: string;
};

type CronManageInput = {
  action: 'create' | 'update' | 'delete' | 'run';
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: unknown;
  payload?: unknown;
  notify?: unknown;
};

const cronListSchema = z.object({
  id: z.string().optional().describe('任务 id。省略则列出当前用户的全部任务；提供则返回单个任务的完整详情。'),
});

const cronManageSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'run']).describe('create = 新建任务；update = 修改已有任务的部分字段；delete = 删除任务；run = 立即触发一次。'),
  id: z.string().optional().describe('任务 id。update/delete/run 必填。'),
  name: z.string().min(1).optional().describe('任务名称。create 必填。'),
  description: z.string().optional(),
  enabled: z.boolean().optional().describe('任务是否启用。create 时默认 true。'),
  schedule: cronScheduleSchema.optional().describe('create 必填。kind=cron：{expr: "0 9 * * *", tz: "Asia/Shanghai"}；kind=every：{everyMs}；kind=at：{atMs: epoch 毫秒}。'),
  payload: z.union([cronPayloadSchema, cronPayloadPatchSchema]).optional().describe('create 必填。kind=agentTurn：{message} 以任务所有者身份在全新会话中执行一轮 agent；kind=systemEvent：{text} 纯通知文本。'),
  notify: notifyConfigSchema.optional().describe('任务完成后的结果推送，如 {"enabled":true,"channel":"web"}。dingtalk 渠道需要用户提供 mode 及 conversationId/userId/chatId。'),
});

export const cronListToolDescriptor: ToolDescriptor<CronListInput> = {
  id: 'CronList',
  name: 'CronList',
  displayName: 'List Cron Jobs',
  description: loadToolDescription('CronList'),
  schema: cronListSchema,
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'cron.read',
  category: 'cron',
  label: '列出定时任务',
};

export const cronManageToolDescriptor: ToolDescriptor<CronManageInput> = {
  id: 'CronManage',
  name: 'CronManage',
  displayName: 'Manage Cron Jobs',
  description: loadToolDescription('CronManage'),
  schema: cronManageSchema,
  risk: 'dangerous',
  approvalMode: 'web',
  auditCategory: 'cron.manage',
  category: 'cron',
  label: '管理定时任务',
};

interface CronIdentity {
  id: string;
  username: string;
}

/**
 * 会话归属者优先：scheduler wake / approval resume / interaction resume 三条
 * raw runtime 路径只填 sessionOwner 不填 user（与 McpClientToolProvider 的
 * resolveOwnerUsername 同一约定）；admin 代操作场景下任务也应归会话主人。
 */
function resolveIdentity(context?: ToolCallContext): CronIdentity | undefined {
  const identity = context?.channelContext?.sessionOwner ?? context?.channelContext?.user;
  if (!identity?.id || !identity.username) return undefined;
  return { id: identity.id, username: identity.username };
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
}

export class CronToolProvider implements ToolProvider {
  constructor(private readonly options: CronToolProviderOptions) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    if (!this.options.service()) return [];
    if (!resolveIdentity(context)) return [];
    return [cronListToolDescriptor, cronManageToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== cronListToolDescriptor.id && call.toolId !== cronManageToolDescriptor.id) {
      return undefined;
    }
    const service = this.options.service();
    if (!service) throw new Error('定时任务服务未启用');
    const identity = resolveIdentity(context);
    if (!identity) throw new Error('缺少当前用户身份，无法访问定时任务');

    if (call.toolId === cronListToolDescriptor.id) {
      const input = cronListSchema.parse(call.input ?? {}) as CronListInput;
      return this.query(service, identity, input);
    }
    const input = cronManageSchema.parse(call.input ?? {}) as CronManageInput;
    return this.manage(service, identity, input);
  }

  private async query(service: CronService, identity: CronIdentity, input: CronListInput): Promise<ToolResult> {
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
