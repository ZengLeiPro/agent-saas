/**
 * Agent 活动分组的折叠摘要（纯函数，无 DOM / React 依赖）。
 *
 * 与 `web/src/components/ActivityGroupBlock.tsx` + `RuntimeStatusBlock.tsx` 同源：
 * Web 组件只做 DOM 绑定，「这一组现在算什么状态、折叠行该说哪一句」全部落在这里。
 * 折叠行是非 debug 用户唯一能看到的执行信息，两端说法不一致就是演示事故。
 */
import type { MessageItem } from '../types/message';
import { POLICY_REJECTION_FAILURE_MESSAGE } from './runtimeErrorMessage';
import type { ActivityStatusTone } from './activityStatusTone';

type RuntimeStatusItem = Extract<MessageItem, { type: 'runtime_status' }>;
export type RuntimeStatus = RuntimeStatusItem['status'];

/** 运行状态图标语义位。渲染层各自挑图标实现，语义键必须两端一致。 */
export type RuntimeStatusIcon = 'loader' | 'clock' | 'server' | 'shield' | 'user';

export interface GroupSummaryInfo {
  text: string;
  tone: ActivityStatusTone;
  durationMs?: number;
  /** 「第 n / 共 m」进度位，仅活动中给出 */
  progress?: string;
  /** true = 仍在推进（转圈），false = 停在某个态（等待 / 终态） */
  active: boolean;
}

/** 分组折叠行使用的短标签（排队中/处理中/待处理/待补充）。 */
export function getRuntimeStatusLabel(status: RuntimeStatus): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '处理中';
    case 'waiting_approval':
      return '待处理';
    case 'waiting_user':
      return '待补充';
    default:
      return '执行中';
  }
}

/** 独立 runtime_status 行使用的完整标签 + 图标语义位。 */
export function getRuntimeStatusMeta(status: RuntimeStatus): {
  label: string;
  icon: RuntimeStatusIcon;
} {
  switch (status) {
    case 'sending':
      return { label: '正在发送消息', icon: 'loader' };
    case 'queued':
      return { label: '已进入队列', icon: 'clock' };
    case 'running':
      return { label: '正在思考', icon: 'loader' };
    case 'waiting_hand':
      return { label: '正在准备工作区', icon: 'server' };
    case 'waiting_approval':
      return { label: '待处理', icon: 'shield' };
    case 'waiting_user':
      return { label: '待补充', icon: 'user' };
    case 'reconnecting':
      return { label: '正在恢复连接', icon: 'loader' };
    default:
      return { label: '正在处理', icon: 'loader' };
  }
}

export function getRuntimeStatusTone(status: RuntimeStatus): ActivityStatusTone {
  switch (status) {
    case 'queued':
      return 'pending';
    case 'waiting_approval':
    case 'waiting_user':
      return 'warning';
    default:
      return 'active';
  }
}

export function isWaitingForUserAction(item: MessageItem): boolean {
  return (
    item.type === 'runtime_status' &&
    (item.status === 'waiting_approval' || item.status === 'waiting_user')
  );
}

export function isActiveActivity(item: MessageItem): boolean {
  if (item.type === 'runtime_status') return true;
  if (item.type === 'thinking') return Boolean(item.streaming);
  if (item.type === 'subagent') return item.status === 'running';
  if (item.type === 'tool_use') {
    if (item.executionStatus === 'running' || item.streaming) return true;
    return (
      !item.resultReady &&
      item.executionStatus !== 'completed' &&
      item.executionStatus !== 'failed' &&
      item.executionStatus !== 'cancelled'
    );
  }
  return false;
}

/** 等待人工的项优先于「还在跑」的项——用户要先看到「该我了」。 */
export function getActiveItemIndex(items: readonly MessageItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (isWaitingForUserAction(items[i])) return i;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    if (isActiveActivity(items[i])) return i;
  }
  return -1;
}

export function getActivityDurationMs(items: readonly MessageItem[]): number | undefined {
  let total = 0;
  let hasDuration = false;
  for (const item of items) {
    if (
      (item.type === 'thinking' || item.type === 'tool_use' || item.type === 'subagent') &&
      typeof item.durationMs === 'number'
    ) {
      total += item.durationMs;
      hasDuration = true;
    }
  }
  return hasDuration ? total : undefined;
}

/** 完成后的标题：把各条业务摘要标题去重拼起来，超长截断补「等」。 */
export function getCompletedGroupTitle(items: readonly MessageItem[]): string {
  const titles = items
    .flatMap((item) =>
      (item.type === 'tool_use' || item.type === 'tool_result' || item.type === 'subagent') &&
      item.presentation?.title
        ? [item.presentation.title]
        : [],
    )
    .filter((title, index, all) => all.indexOf(title) === index);
  if (titles.length === 0) return '已运行';

  const shown: string[] = [];
  for (const title of titles) {
    if (shown.length > 0 && [...shown, title].join('、').length > 42) break;
    shown.push(title);
  }
  return `${shown.join('、')}${shown.length < titles.length ? ' 等' : ''}`;
}

function getActiveGroupSummary(items: readonly MessageItem[]): GroupSummaryInfo {
  const index = getActiveItemIndex(items);
  if (index < 0) return { text: '处理中', tone: 'active', active: true };

  const item = items[index];
  const progress = `${index + 1}/${items.length}`;

  if (item.type === 'runtime_status') {
    const text = getRuntimeStatusLabel(item.status);
    if (item.status === 'waiting_approval' || item.status === 'waiting_user') {
      return { text, tone: 'warning', progress, active: false };
    }
    if (item.status === 'queued') return { text, tone: 'pending', progress, active: false };
    return { text, tone: 'active', progress, active: true };
  }

  if (item.type === 'thinking') return { text: '思考中', tone: 'active', progress, active: true };
  return { text: '执行中', tone: 'active', progress, active: true };
}

/**
 * 分组折叠行摘要。
 *
 * `debugMode` 只影响完成态标题：非调试视图固定说「已运行」，
 * 不能把自动生成的工具标题误当成业务摘要泄露给客户。
 */
export function selectActivityGroupSummary(
  items: readonly MessageItem[],
  isActive: boolean,
  debugMode = false,
): GroupSummaryInfo {
  if (isActive) return getActiveGroupSummary(items);

  const hasPolicyRejection = items.some(
    (item) =>
      item.type === 'subagent' &&
      item.failureKind === 'policy_rejection' &&
      item.recoveryAction === 'switch_model',
  );
  if (hasPolicyRejection) {
    return {
      text: POLICY_REJECTION_FAILURE_MESSAGE,
      tone: 'danger',
      ...durationField(items),
      active: false,
    };
  }

  const cancelledCount = items.filter(
    (item) =>
      (item.type === 'tool_use' && item.executionStatus === 'cancelled') ||
      (item.type === 'subagent' && item.status === 'cancelled'),
  ).length;
  if (cancelledCount > 0) {
    return {
      text: `已取消 ${cancelledCount} 条 · 共 ${items.length} 条`,
      tone: 'neutral',
      ...durationField(items),
      active: false,
    };
  }

  return {
    text: debugMode ? getCompletedGroupTitle(items) : '已运行',
    tone: 'success',
    ...durationField(items),
    active: false,
  };
}

function durationField(items: readonly MessageItem[]): { durationMs?: number } {
  const durationMs = getActivityDurationMs(items);
  return durationMs === undefined ? {} : { durationMs };
}
