/**
 * Cron 任务调度系统类型定义
 */

import { z } from 'zod';

// ============ 调度配置 ============

/** 一次性任务：指定时间戳执行 */
export interface ScheduleAt {
  kind: "at";
  atMs: number; // Unix 时间戳（毫秒）
}

/** 间隔任务：每隔固定时间执行 */
export interface ScheduleEvery {
  kind: "every";
  everyMs: number; // 间隔毫秒数
  anchorMs?: number; // 锚点时间（可选，用于对齐）
}

/** Cron 表达式任务 */
export interface ScheduleCron {
  kind: "cron";
  expr: string; // 5 字段 Cron 表达式
  tz?: string; // IANA 时区（如 Asia/Shanghai）
}

export type CronSchedule = ScheduleAt | ScheduleEvery | ScheduleCron;

// ============ 任务负载 ============

/** Agent 上下文注入配置 */
export interface AgentContextConfig {
  systemPrompt?: boolean; // 是否加载系统提示语（默认 true）
  persona?: boolean; // 是否加载 PERSONA.md（默认 true）
  memory?: boolean; // 是否加载 MEMORY.md（默认 true）
}

/** Agent 执行任务 */
export interface PayloadAgentTurn {
  kind: "agentTurn";
  message: string; // 发送给 Agent 的提示词
  model?: string; // 模型覆盖（可选）
  maxTurns?: number; // 最大轮次（可选）
  timeoutSeconds?: number; // 超时秒数（可选）
  context?: AgentContextConfig; // 上下文注入配置（可选）
}

/** 系统事件任务（简单通知） */
export interface PayloadSystemEvent {
  kind: "systemEvent";
  text: string; // 事件文本
}

export type CronPayload = PayloadAgentTurn | PayloadSystemEvent;

export type PayloadAgentTurnPatch = {
  kind?: "agentTurn";
  message?: string;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
  context?: AgentContextConfig;
};

export type PayloadSystemEventPatch = {
  kind?: "systemEvent";
  text?: string;
};

export type CronPayloadPatch = PayloadAgentTurnPatch | PayloadSystemEventPatch;

// ============ 通知配置 ============

export interface NotifyConfig {
  enabled: boolean;
  channel: "dingtalk" | "web" | "both";
  onSuccess?: boolean; // 成功时通知（默认 true）
  onError?: boolean; // 失败时通知（默认 true）
  /**
   * 钉钉通知目标（当 channel 包含 dingtalk 时必填）
   * - mode=session: 用 conversationId 从 dingtalk-sessions.json 定位 sessionWebhook（90分钟有效）
   * - mode=user: 主动私聊发送（需要 userId）
   * - mode=chat: 主动群聊发送（需要 chatId=openConversationId）
   */
  dingtalk?: {
    mode?: "session" | "user" | "chat";
    /** mode=session 时必填 */
    conversationId?: string;
    /** mode=user 时必填 */
    userId?: string | string[];
    /** mode=chat 时必填 */
    chatId?: string;
  };
}

// ============ 任务状态 ============

export interface CronJobState {
  nextRunAtMs?: number; // 下次执行时间
  runningAtMs?: number; // 正在执行的开始时间
  lastRunAtMs?: number; // 上次执行时间
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string; // 上次错误信息
  lastDurationMs?: number; // 上次执行耗时
  lastOutput?: string; // 上次执行输出（截断）
}

// ============ 任务定义 ============

/**
 * 平台系统任务类型（2026-07-14 记忆轮询批次）。
 * - 'memory_poll'：每日记忆轮询。由平台自动预置（每用户一条），执行时忽略
 *   payload.message、加载服务端版本化提示语，并套用受限工具白名单。
 * 用户不能通过 REST API 创建/修改 systemKind 任务（routes/cron.ts 拒绝），
 * 真源是本字段；「记忆轮询/心跳轮询」名称后缀匹配仅作存量任务兼容。
 */
export type CronSystemKind = "memory_poll";

export interface CronJob {
  id: string; // UUID
  name: string; // 任务名称
  description?: string; // 任务描述
  enabled: boolean; // 是否启用
  /** 平台系统任务标识（用户不可创建/修改；见 CronSystemKind 注释） */
  systemKind?: CronSystemKind;

  schedule: CronSchedule; // 调度配置
  payload: CronPayload; // 任务内容
  notify?: NotifyConfig; // 通知配置

  owner?: string; // 创建者 userId (JwtPayload.sub)
  ownerName?: string; // 创建者用户名（纯展示）

  createdAtMs: number; // 创建时间
  updatedAtMs: number; // 更新时间

  state: CronJobState; // 运行状态
}

// ============ API 类型 ============

/** 创建任务请求 */
export interface CronJobCreate {
  name: string;
  description?: string;
  enabled?: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  notify?: NotifyConfig;
}

/** 更新任务请求 */
export interface CronJobPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  payload?: CronPayloadPatch;
  notify?: NotifyConfig;
}

// ============ 存储格式 ============

export interface CronStoreFile {
  version: 1 | 2;
  jobs: CronJob[];
}

// ============ 运行日志 ============

export interface CronRunLogEntry {
  /** 每次运行的唯一 ID */
  runId: string;
  /** 开始时间戳（ms） */
  startedAtMs: number;
  /** 结束时间戳（ms） */
  endedAtMs: number;
  jobId: string;
  jobName: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  /**
   * SDK 持久化会话 ID（对应 ~/.agent-saas/legacy-transcripts/<tenantId>/<userId>/ 下一份 transcript）
   * 仅用于定位日志，不用于 resume（Cron 每次运行都新建 session）
   */
  sessionId?: string;
  /**
   * SDK transcript 真实路径（仅服务端使用；前端列表接口不直接返回）
   */
  transcriptPath?: string;
  /** 本次运行使用的模型引用（"groupId/modelId"），用于前端会话恢复 */
  model?: string;
  durationMs: number;
}

// ============ 服务状态 ============

export interface CronServiceStatus {
  enabled: boolean;
  jobCount: number;
  enabledJobCount: number;
  nextWakeAtMs?: number;
  runningJobId?: string;      // 保留向后兼容
  runningJobIds?: string[];   // 所有正在运行的 job
}

// ============ 事件类型 ============

export type CronEvent =
  | { type: "started"; jobId: string; jobName: string }
  | {
      type: "finished";
      jobId: string;
      jobName: string;
      status: "ok" | "error" | "skipped";
      error?: string;
      durationMs: number;
      sessionId?: string;
      owner?: string;
      output?: string;
    }
  | { type: "statusChanged"; status: CronServiceStatus };

// ============ Zod Schemas ============

const scheduleAtSchema = z.object({
  kind: z.literal("at"),
  atMs: z.number().int().positive(),
});

const scheduleEverySchema = z.object({
  kind: z.literal("every"),
  everyMs: z.number().int().positive(),
  anchorMs: z.number().int().positive().optional(),
});

const scheduleCronSchema = z.object({
  kind: z.literal("cron"),
  expr: z.string().min(1),
  tz: z.string().optional(),
});

export const cronScheduleSchema = z.discriminatedUnion("kind", [
  scheduleAtSchema,
  scheduleEverySchema,
  scheduleCronSchema,
]);

const agentContextConfigSchema = z.object({
  systemPrompt: z.boolean().optional(),
  persona: z.boolean().optional(),
  memory: z.boolean().optional(),
});

const payloadAgentTurnSchema = z.object({
  kind: z.literal("agentTurn"),
  message: z.string().min(1),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().min(0).optional(),
  context: agentContextConfigSchema.optional(),
});

const payloadSystemEventSchema = z.object({
  kind: z.literal("systemEvent"),
  text: z.string().min(1),
});

export const cronPayloadSchema = z.discriminatedUnion("kind", [
  payloadAgentTurnSchema,
  payloadSystemEventSchema,
]);

const payloadAgentTurnPatchSchema = z.object({
  kind: z.literal("agentTurn").optional(),
  message: z.string().min(1).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().min(0).optional(),
  context: agentContextConfigSchema.optional(),
}).strict();

const payloadSystemEventPatchSchema = z.object({
  kind: z.literal("systemEvent").optional(),
  text: z.string().min(1).optional(),
}).strict();

export const cronPayloadPatchSchema = z.union([
  payloadAgentTurnPatchSchema,
  payloadSystemEventPatchSchema,
]);

export const notifyConfigSchema = z.object({
  enabled: z.boolean(),
  channel: z.enum(["dingtalk", "web", "both"]),
  onSuccess: z.boolean().optional(),
  onError: z.boolean().optional(),
  dingtalk: z.object({
    mode: z.enum(["session", "user", "chat"]).optional(),
    conversationId: z.string().optional(),
    userId: z.union([z.string(), z.array(z.string())]).optional(),
    chatId: z.string().optional(),
  }).optional(),
});

export const cronJobCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: cronScheduleSchema,
  payload: cronPayloadSchema,
  notify: notifyConfigSchema.optional(),
});

export const cronJobPatchSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: cronScheduleSchema.optional(),
  payload: cronPayloadPatchSchema.optional(),
  notify: notifyConfigSchema.optional(),
});
