/**
 * 业务步骤的状态语义（纯函数，无 DOM / React 依赖）。
 *
 * 与 `web/src/components/BusinessStepFlow.tsx` 的 `statusMeta` /
 * `businessStepOverallStatus` / `OUTCOME_TONE_META` 同源。步骤流是销售演示的主线，
 * 「这一步现在算什么」必须两端一句话对齐——Web 说「完成结果异常」而 App 说
 * 「已完成」，客户会认为平台在掩盖问题。
 */
import type { TodoItem, TodoOutcome, TodoStatus } from './extractTodos';
import type { ActivityStatusTone } from './activityStatusTone';

/** 图标语义位。两端各自挑图标实现，语义键必须一致。 */
export type BusinessStepIcon = 'progress' | 'clock' | 'alert' | 'check' | 'x' | 'circle';

export interface BusinessStepStatusMeta {
  label: string;
  tone: ActivityStatusTone;
  icon: BusinessStepIcon;
  /** 图标是否需要持续旋转 */
  spin: boolean;
}

/**
 * 单个步骤的状态标签 / 语气 / 图标。
 *
 * 「已完成 + outcome.tone=fail」优先判为「完成结果异常」：干净的绿勾不允许
 * 掩盖一次业务上失败的执行。
 */
export function todoStatusMeta(todo: TodoItem, planClosed = false): BusinessStepStatusMeta {
  if (isEndedWithoutTerminal(todo, planClosed)) {
    return { label: '已结束', tone: 'neutral', icon: 'circle', spin: false };
  }
  if (todo.status === 'completed' && todo.outcome?.tone === 'fail') {
    return { label: '完成结果异常', tone: 'danger', icon: 'x', spin: false };
  }
  switch (todo.status) {
    case 'in_progress':
      return { label: '进行中', tone: 'active', icon: 'progress', spin: true };
    case 'waiting':
      return { label: '等待中', tone: 'pending', icon: 'clock', spin: false };
    case 'blocked':
      return { label: '已阻断', tone: 'danger', icon: 'alert', spin: false };
    case 'completed':
      return { label: '已完成', tone: 'success', icon: 'check', spin: false };
    case 'failed':
      return { label: '失败', tone: 'danger', icon: 'x', spin: false };
    default:
      return { label: '待执行', tone: 'neutral', icon: 'circle', spin: false };
  }
}

export type BusinessStepOverallLabel =
  '运行中' | '已阻断' | '有失败' | '等待中' | '已完成' | '已结束' | '待处理';

export interface BusinessStepOverallStatus {
  completed: number;
  label: BusinessStepOverallLabel;
  tone: ActivityStatusTone;
}

/** 计划整体状态。judgement 顺序即优先级：进行中 > 阻断 > 失败 > 等待 > 完成。 */
export function businessStepOverallStatus(
  todos: readonly TodoItem[],
  planClosed = false,
): BusinessStepOverallStatus {
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  if (!planClosed && todos.some((todo) => todo.status === 'in_progress')) {
    return { completed, label: '运行中', tone: 'active' };
  }
  if (todos.some((todo) => todo.status === 'blocked')) {
    return { completed, label: '已阻断', tone: 'danger' };
  }
  if (todos.some((todo) => todo.status === 'failed')) {
    return { completed, label: '有失败', tone: 'danger' };
  }
  if (todos.some((todo) => todo.status === 'waiting')) {
    return { completed, label: '等待中', tone: 'pending' };
  }
  if (todos.length > 0 && completed === todos.length) {
    return { completed, label: '已完成', tone: 'success' };
  }
  if (planClosed) return { completed, label: '已结束', tone: 'neutral' };
  return { completed, label: '待处理', tone: 'neutral' };
}

/** 一句业务结果的语气位：ok 用正文色不加图标，warn / fail 加图标并上语义色。 */
export function outcomeToneMeta(outcome: TodoOutcome | undefined): {
  tone: ActivityStatusTone;
  icon: BusinessStepIcon | null;
} {
  switch (outcome?.tone) {
    case 'warn':
      return { tone: 'warning', icon: 'alert' };
    case 'fail':
      return { tone: 'danger', icon: 'x' };
    default:
      return { tone: 'neutral', icon: null };
  }
}

/** 计划已结束但该步仍停在 in_progress：终态缺失，按「已结束」呈现而不是继续转圈。 */
export function isEndedWithoutTerminal(todo: TodoItem, planClosed?: boolean): boolean {
  return !!planClosed && todo.status === 'in_progress';
}

/** 无障碍朗读用的步骤状态短语。 */
export function todoAccessibleStatus(todo: TodoItem, planClosed?: boolean): string {
  return todoStatusMeta(todo, planClosed).label;
}

/** 结构化结果缺失不等于没有执行；只陈述已知状态，不推断成功或生成业务结论。 */
export function businessStepResultPlaceholder(
  todo: TodoItem,
  planClosed = false,
  hasProcess = false,
): string {
  if (isEndedWithoutTerminal(todo, planClosed)) return '本轮执行已结束，步骤状态未更新';
  switch (todo.status) {
    case 'pending':
      return hasProcess ? '已有过程记录，步骤状态待更新' : '待执行';
    case 'in_progress':
      return hasProcess ? '已有过程记录，尚未形成结论' : todo.activeForm || '执行中，尚未形成结论';
    case 'waiting':
      return '等待中，尚未提供等待原因';
    case 'blocked':
      return '执行受阻，尚未提供原因';
    case 'failed':
      return '执行失败，尚未提供结果说明';
    case 'completed':
      return '已完成，未提供步骤摘要';
  }
}

export type { TodoStatus };
