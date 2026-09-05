/**
 * 定时任务的纯派生层：排序、调度文案、下次运行时间、状态语义、选项表与 Cron 预设。
 *
 * 口径全部对齐 Web `web/src/components/CronManager/`：
 *   - 列表排序：`hooks.ts` 的 `sortByNextRun`
 *   - 调度/下次运行文案：`JobList.tsx` 的 `formatSchedule` / `formatNextRun`
 *   - 运行状态语义：`RunHistory.tsx` 的 statusBadge（成功=success / 失败=danger / 跳过=muted）
 *
 * 本模块不依赖任何 UI 框架，端侧只负责把语义 token 映射成自己的组件。
 */
import type {
  CronJob,
  CronRunLogEntry,
  CronRunTrigger,
  CronSchedule,
  NotifyConfig,
} from '../types/cron';
import type { ModelList } from '../types/models';

/** 运行状态语义档（与 mobile `ui/statusStyles.ts` 的 RunStatus 同集合）。 */
export type CronStatusTone = 'running' | 'success' | 'error' | 'pending' | 'cancelled';

export interface CronOption<T extends string> {
  value: T;
  label: string;
  /** 选项下方的补充说明（端侧可选渲染） */
  hint?: string;
}

// ── 排序 ───────────────────────────────────────────────────────────────

/** 按下次运行时间升序；没有下次运行的排在最后。 */
export function sortCronJobsByNextRun(jobs: readonly CronJob[]): CronJob[] {
  return [...jobs].sort(
    (a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity),
  );
}

// ── 调度与时间文案 ─────────────────────────────────────────────────────

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

/** 调度摘要：`一次性 · 2026-09-05 09:00` / `每 30 分钟` / `Cron 0 9 * * *`。 */
export function formatCronSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at':
      return `一次性 · ${formatDateTime(schedule.atMs)}`;
    case 'every': {
      const mins = Math.max(1, Math.floor(schedule.everyMs / 60000));
      if (mins < 60) return `每 ${mins} 分钟`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `每 ${hours} 小时`;
      return `每 ${Math.floor(hours / 24)} 天`;
    }
    case 'cron':
      // 时区对用户没意义，只显示表达式（对齐 Web JobList）
      return `Cron ${schedule.expr}`;
  }
}

/** 下次运行的相对时间：今天 HH:mm / 明天 HH:mm / M/D HH:mm；无值返回 '-'。 */
export function formatCronNextRun(ms?: number, nowMs: number = Date.now()): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const now = new Date(nowMs);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDate = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDate(d, now)) return `今天 ${hm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDate(d, tomorrow)) return `明天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 运行耗时：`0.8s` / `12.0s`（对齐 Web RunHistory 的一位小数秒）。 */
export function formatCronRunDuration(ms?: number): string {
  if (!Number.isFinite(ms) || ms == null || ms < 0) return '-';
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── 状态语义 ───────────────────────────────────────────────────────────

/** 单次运行记录 → 状态语义档。 */
export function cronRunStatusTone(status: CronRunLogEntry['status']): CronStatusTone {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'error';
  return 'cancelled';
}

/** 单次运行的中文状态名。 */
export function cronRunStatusLabel(status: CronRunLogEntry['status']): string {
  if (status === 'ok') return '成功';
  if (status === 'error') return '失败';
  return '跳过';
}

/**
 * 任务行的状态语义：运行中 > 已禁用（pending）> 最近一次运行结果。
 * 禁用任务不展示上一次的绿/红，避免「停用了还像在跑」。
 */
export function cronJobStatusTone(job: CronJob): CronStatusTone {
  if (job.state.runningAtMs) return 'running';
  if (!job.enabled) return 'cancelled';
  if (job.state.lastStatus === 'ok') return 'success';
  if (job.state.lastStatus === 'error') return 'error';
  return 'pending';
}

/** 任务行的状态文案。 */
export function cronJobStatusLabel(job: CronJob): string {
  if (job.state.runningAtMs) return '运行中';
  if (!job.enabled) return '已停用';
  if (job.state.lastStatus === 'ok') return '成功';
  if (job.state.lastStatus === 'error') return '失败';
  return '待运行';
}

/** 触发方式文案。 */
export function cronRunTriggerLabel(trigger?: CronRunTrigger): string {
  if (trigger === 'manual') return '手动';
  if (trigger === 'retry') return '重试';
  return '定时';
}

/** 运行摘要（对齐 Web RunHistory 的「摘要」列）。 */
export function cronRunSummary(entry: CronRunLogEntry, maxLength = 200): string {
  if (entry.status === 'ok') return '运行成功';
  if (entry.status === 'skipped') return '已跳过';
  const error = entry.error?.trim();
  if (!error) return '运行失败';
  return error.length > maxLength ? `${error.slice(0, maxLength)}…` : error;
}

// ── 列表行副标题 ───────────────────────────────────────────────────────

/** `groupId/modelId` → 展示名；解析不出来时回落原始 ref。 */
export function resolveCronModelLabel(ref: string, modelList?: ModelList | null): string {
  if (!modelList) return ref;
  const slashIdx = ref.indexOf('/');
  if (slashIdx < 0) return ref;
  const group = modelList.groups.find((g) => g.id === ref.slice(0, slashIdx));
  const model = group?.models.find((m) => m.id === ref.slice(slashIdx + 1));
  return model?.name ?? ref;
}

/** 列表行副标题：`调度 · 下次运行 · 模型`（缺项自动省略）。 */
export function cronJobSubtitle(
  job: CronJob,
  options: { modelList?: ModelList | null; nowMs?: number } = {},
): string {
  const parts = [formatCronSchedule(job.schedule)];
  if (job.state.nextRunAtMs) {
    parts.push(`下次 ${formatCronNextRun(job.state.nextRunAtMs, options.nowMs ?? Date.now())}`);
  }
  if (job.payload.kind === 'agentTurn' && job.payload.model) {
    parts.push(resolveCronModelLabel(job.payload.model, options.modelList));
  }
  return parts.join(' · ');
}

// ── 选项表（与 Web JobForm 的下拉一一对应）─────────────────────────────

export type CronScheduleKind = CronSchedule['kind'];
export type CronPayloadKind = 'agentTurn' | 'systemEvent';
export type CronDingtalkMode = 'session' | 'user' | 'chat';

export const CRON_SCHEDULE_KIND_OPTIONS: readonly CronOption<CronScheduleKind>[] = [
  { value: 'every', label: '间隔执行' },
  { value: 'cron', label: 'Cron 表达式' },
  { value: 'at', label: '一次性执行' },
];

export const CRON_PAYLOAD_KIND_OPTIONS: readonly CronOption<CronPayloadKind>[] = [
  { value: 'agentTurn', label: 'Agent 执行' },
  { value: 'systemEvent', label: '系统事件' },
];

export const CRON_NOTIFY_CHANNEL_OPTIONS: readonly CronOption<NotifyConfig['channel']>[] = [
  { value: 'web', label: 'Web' },
  { value: 'dingtalk', label: '钉钉' },
  { value: 'both', label: '两者' },
];

export const CRON_DINGTALK_MODE_OPTIONS: readonly CronOption<CronDingtalkMode>[] = [
  {
    value: 'session',
    label: 'sessionWebhook（90 分钟有效）',
    hint: '依赖 sessionWebhook，更适合「刚刚在钉钉里交互过」的短期通知。',
  },
  {
    value: 'user',
    label: '主动私聊（userId）',
    hint: '主动私聊不依赖 sessionWebhook；userId 通常取自会话列表的 senderId。',
  },
  {
    value: 'chat',
    label: '主动群聊（chatId）',
    hint: '主动群聊不依赖 sessionWebhook；chatId 通常以 cid... 开头。',
  },
];

/** 通知渠道是否需要填钉钉目标。 */
export function cronNotifyNeedsDingtalk(
  enabled: boolean,
  channel: NotifyConfig['channel'],
): boolean {
  return enabled && (channel === 'dingtalk' || channel === 'both');
}

/** 常用时区（移动端没有系统时区选择器，给一份短清单 + 当前设备时区）。 */
export const CRON_TIMEZONE_PRESETS: readonly string[] = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Singapore',
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
];

/** 常用 5 字段 Cron 表达式预设。 */
export const CRON_EXPR_PRESETS: readonly CronOption<string>[] = [
  { value: '0 9 * * *', label: '每天 09:00' },
  { value: '0 18 * * *', label: '每天 18:00' },
  { value: '0 9 * * 1-5', label: '工作日 09:00' },
  { value: '0 9 * * 1', label: '每周一 09:00' },
  { value: '0 9 1 * *', label: '每月 1 日 09:00' },
  { value: '0 * * * *', label: '每小时整点' },
  { value: '*/30 * * * *', label: '每 30 分钟' },
];

/** 5 字段形态的本地预检（服务端仍是唯一权威）。 */
export function isFiveFieldCronExpr(expr: string): boolean {
  return expr.trim().split(/\s+/).filter(Boolean).length === 5;
}
