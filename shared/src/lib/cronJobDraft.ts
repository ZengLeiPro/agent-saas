/**
 * 定时任务表单草稿模型：`CronJob` ⇄ 扁平草稿 ⇄ `CronJobCreate` 的纯转换。
 *
 * 字段集与默认值一比一对齐 Web `web/src/components/CronManager/JobForm.tsx`
 * （名称/描述/启用、调度三选一、时区、模型、任务类型、最大轮次、超时、
 *  上下文注入三开关、通知渠道与钉钉三种发送方式、成功/失败通知）。
 *
 * 表单校验、`context` 省略规则、`notify` 组装规则都在这里，端侧 UI 只负责
 * 把草稿字段绑到控件上——两端不会再各写一份「什么时候该带 context」。
 */
import type {
  CronJob,
  CronJobCreate,
  CronPayload,
  CronSchedule,
  NotifyConfig,
} from '../types/cron';
import type { CronDingtalkMode, CronPayloadKind, CronScheduleKind } from './cronPresentation';
import { cronNotifyNeedsDingtalk } from './cronPresentation';

/** 「使用默认模型」的哨兵值（不落库，提交时剔除）。 */
export const CRON_MODEL_DEFAULT_VALUE = '__default__';

export const CRON_DRAFT_DEFAULT_EVERY_MINUTES = 60;
export const CRON_DRAFT_DEFAULT_CRON_EXPR = '0 9 * * *';
export const CRON_DRAFT_DEFAULT_TZ = 'Asia/Shanghai';
export const CRON_DRAFT_DEFAULT_TIMEOUT_SECONDS = '1800';

export interface CronJobDraft {
  name: string;
  description: string;
  enabled: boolean;

  scheduleKind: CronScheduleKind;
  everyMinutes: number;
  cronExpr: string;
  cronTz: string;
  atMs: number;

  payloadKind: CronPayloadKind;
  message: string;
  model: string;
  maxTurns: string;
  timeoutSeconds: string;

  ctxSystemPrompt: boolean;
  ctxPersona: boolean;
  ctxMemory: boolean;

  notifyEnabled: boolean;
  notifyChannel: NotifyConfig['channel'];
  notifyOnSuccess: boolean;
  notifyOnError: boolean;
  dingtalkMode: CronDingtalkMode;
  dingtalkConversationId: string;
  dingtalkUserId: string;
  dingtalkChatId: string;
}

/** 新建任务的默认草稿；`nowMs` 只影响一次性执行的默认时间（默认一小时后）。 */
export function emptyCronJobDraft(nowMs: number = Date.now()): CronJobDraft {
  return {
    name: '',
    description: '',
    enabled: true,
    scheduleKind: 'every',
    everyMinutes: CRON_DRAFT_DEFAULT_EVERY_MINUTES,
    cronExpr: CRON_DRAFT_DEFAULT_CRON_EXPR,
    cronTz: CRON_DRAFT_DEFAULT_TZ,
    atMs: nowMs + 3600_000,
    payloadKind: 'agentTurn',
    message: '',
    model: CRON_MODEL_DEFAULT_VALUE,
    maxTurns: '',
    timeoutSeconds: CRON_DRAFT_DEFAULT_TIMEOUT_SECONDS,
    ctxSystemPrompt: true,
    ctxPersona: true,
    ctxMemory: true,
    notifyEnabled: false,
    notifyChannel: 'web',
    notifyOnSuccess: true,
    notifyOnError: true,
    dingtalkMode: 'session',
    dingtalkConversationId: '',
    dingtalkUserId: '',
    dingtalkChatId: '',
  };
}

/** 已有任务 → 草稿；缺省字段回落到新建默认值。 */
export function cronJobToDraft(job: CronJob | undefined, nowMs: number = Date.now()): CronJobDraft {
  const draft = emptyCronJobDraft(nowMs);
  if (!job) return draft;

  draft.name = job.name ?? '';
  draft.description = job.description ?? '';
  draft.enabled = !!job.enabled;

  draft.scheduleKind = job.schedule.kind;
  if (job.schedule.kind === 'every') {
    draft.everyMinutes = Math.max(1, Math.round(job.schedule.everyMs / 60000));
  } else if (job.schedule.kind === 'cron') {
    draft.cronExpr = job.schedule.expr || '';
    draft.cronTz = job.schedule.tz ?? '';
  } else {
    draft.atMs = job.schedule.atMs;
  }

  if (job.payload.kind === 'agentTurn') {
    draft.payloadKind = 'agentTurn';
    draft.message = job.payload.message ?? '';
    draft.model = job.payload.model || CRON_MODEL_DEFAULT_VALUE;
    draft.maxTurns = typeof job.payload.maxTurns === 'number' ? String(job.payload.maxTurns) : '';
    draft.timeoutSeconds =
      typeof job.payload.timeoutSeconds === 'number' ? String(job.payload.timeoutSeconds) : '';
    draft.ctxSystemPrompt = job.payload.context?.systemPrompt ?? true;
    draft.ctxPersona = job.payload.context?.persona ?? true;
    draft.ctxMemory = job.payload.context?.memory ?? true;
  } else {
    draft.payloadKind = 'systemEvent';
    draft.message = job.payload.text ?? '';
    draft.maxTurns = '';
    draft.timeoutSeconds = '';
  }

  const notify = job.notify;
  draft.notifyEnabled = !!notify?.enabled;
  draft.notifyChannel = notify?.channel ?? 'web';
  draft.notifyOnSuccess = notify?.onSuccess ?? true;
  draft.notifyOnError = notify?.onError ?? true;
  draft.dingtalkMode = notify?.dingtalk?.mode ?? 'session';
  draft.dingtalkConversationId = notify?.dingtalk?.conversationId ?? '';
  const userId = notify?.dingtalk?.userId;
  draft.dingtalkUserId = Array.isArray(userId) ? userId.map(String).join(',') : (userId ?? '');
  draft.dingtalkChatId = notify?.dingtalk?.chatId ?? '';

  return draft;
}

export type CronDraftBuildResult =
  { ok: true; value: CronJobCreate } | { ok: false; error: string };

function buildSchedule(draft: CronJobDraft): CronSchedule | string {
  switch (draft.scheduleKind) {
    case 'every':
      return { kind: 'every', everyMs: Math.max(1, Math.round(draft.everyMinutes)) * 60000 };
    case 'cron': {
      const expr = draft.cronExpr.trim();
      if (!expr) return '请输入 Cron 表达式';
      const tz = draft.cronTz.trim();
      return { kind: 'cron', expr, ...(tz ? { tz } : {}) };
    }
    case 'at':
      if (!Number.isFinite(draft.atMs)) return '请选择有效的执行时间';
      return { kind: 'at', atMs: draft.atMs };
  }
}

function buildPayload(draft: CronJobDraft): CronPayload | string {
  const message = draft.message.trim();
  if (draft.payloadKind === 'systemEvent') {
    if (!message) return '请输入事件内容';
    return { kind: 'systemEvent', text: message };
  }
  if (!message) return '请输入 Agent 提示词';

  const maxTurns = draft.maxTurns.trim() ? Number.parseInt(draft.maxTurns, 10) : undefined;
  const timeoutSeconds = draft.timeoutSeconds.trim()
    ? Number.parseInt(draft.timeoutSeconds, 10)
    : undefined;

  // 仅在有开关被关闭时才传 context，全部为 true 时省略（与 Web JobForm 一致）
  const hasOverride = !draft.ctxSystemPrompt || !draft.ctxPersona || !draft.ctxMemory;
  const context = hasOverride
    ? {
        ...(draft.ctxSystemPrompt ? {} : { systemPrompt: false as const }),
        ...(draft.ctxPersona ? {} : { persona: false as const }),
        ...(draft.ctxMemory ? {} : { memory: false as const }),
      }
    : undefined;

  return {
    kind: 'agentTurn',
    message,
    ...(draft.model && draft.model !== CRON_MODEL_DEFAULT_VALUE ? { model: draft.model } : {}),
    ...(Number.isFinite(maxTurns) ? { maxTurns } : {}),
    ...(Number.isFinite(timeoutSeconds) ? { timeoutSeconds } : {}),
    ...(context ? { context } : {}),
  };
}

/** 钉钉通知目标的必填校验；通过返回 null。 */
export function validateCronDingtalkTarget(draft: CronJobDraft): string | null {
  if (!cronNotifyNeedsDingtalk(draft.notifyEnabled, draft.notifyChannel)) return null;
  if (draft.dingtalkMode === 'session' && !draft.dingtalkConversationId.trim()) {
    return '请选择钉钉会话（conversationId），用于 sessionWebhook 通知（90 分钟有效）';
  }
  if (draft.dingtalkMode === 'user' && !draft.dingtalkUserId.trim()) {
    return '请填写钉钉 userId，用于主动私聊发送通知';
  }
  if (draft.dingtalkMode === 'chat' && !draft.dingtalkChatId.trim()) {
    return '请填写钉钉 chatId（openConversationId），用于主动群聊发送通知';
  }
  return null;
}

function buildNotify(
  draft: CronJobDraft,
  options: { keepExistingNotify?: boolean },
): NotifyConfig | undefined {
  if (!draft.notifyEnabled && !options.keepExistingNotify) return undefined;
  const needsDingtalk = cronNotifyNeedsDingtalk(draft.notifyEnabled, draft.notifyChannel);
  const dingtalk = {
    mode: draft.dingtalkMode,
    ...(draft.dingtalkMode === 'session'
      ? { conversationId: draft.dingtalkConversationId.trim() }
      : {}),
    ...(draft.dingtalkMode === 'user' ? { userId: draft.dingtalkUserId.trim() } : {}),
    ...(draft.dingtalkMode === 'chat' ? { chatId: draft.dingtalkChatId.trim() } : {}),
  };
  return {
    enabled: draft.notifyEnabled,
    channel: draft.notifyChannel,
    onSuccess: draft.notifyOnSuccess,
    onError: draft.notifyOnError,
    ...(needsDingtalk ? { dingtalk } : {}),
  };
}

/**
 * 草稿 → 提交体。
 * @param options.keepExistingNotify 编辑模式且原任务已有 notify 时传 true，
 *        保证「关掉通知」能被真正下发（而不是省略字段让服务端保留旧配置）。
 */
export function buildCronJobCreate(
  draft: CronJobDraft,
  options: { keepExistingNotify?: boolean } = {},
): CronDraftBuildResult {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: '请输入任务名称' };

  const schedule = buildSchedule(draft);
  if (typeof schedule === 'string') return { ok: false, error: schedule };

  const payload = buildPayload(draft);
  if (typeof payload === 'string') return { ok: false, error: payload };

  const dingtalkError = validateCronDingtalkTarget(draft);
  if (dingtalkError) return { ok: false, error: dingtalkError };

  return {
    ok: true,
    value: {
      name,
      description: draft.description.trim(),
      enabled: draft.enabled,
      schedule,
      payload,
      notify: buildNotify(draft, options),
    },
  };
}

/** 草稿是否被改动过（逐字段浅比较，用于「放弃修改？」拦截）。 */
export function isCronDraftDirty(current: CronJobDraft, initial: CronJobDraft): boolean {
  return (Object.keys(initial) as (keyof CronJobDraft)[]).some(
    (key) => current[key] !== initial[key],
  );
}
