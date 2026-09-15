/**
 * 把已经成型的 `ai_bubble.items` 切成过程 / 刺破 / 计划卡 / 终答。
 *
 * 只消费渲染层现成分组，不改 groupMessages、EventStore 或 WS。
 * 触发必须绑 `text.finalOutput`：失败 done 不打该标记，因此失败轮保持展开。
 */
import type { MessageItem, RenderItem } from '../types/message';
import type { ActivityStatusTone } from './activityStatusTone';
import { formatActivityDuration } from './activityStatusTone';
import { getActivityDurationMs, selectActivityGroupSummary } from './activityGroupSummary';

export interface AssistantTurnPartition {
  process: RenderItem[];
  pierce: RenderItem[];
  keepOut: RenderItem[];
  final: RenderItem[];
  shouldFold: boolean;
}

export interface TurnProcessSummary {
  count: number;
  durationMs?: number;
  writeCount: number;
  title: string;
  subtitle: string;
  tone: ActivityStatusTone;
}

function isFinalText(item: RenderItem): item is Extract<RenderItem, { type: 'text' }> {
  return item.type === 'text' && item.finalOutput === true;
}

function isSettledFinalText(item: RenderItem): boolean {
  return isFinalText(item) && !item.streaming;
}

function isKeepOut(item: RenderItem): boolean {
  if (item.type === 'business_step' && item.kind === 'plan') return true;
  // mobile 主区保留步骤节当详情载体；web flatten 后不会再见到这个类型。
  return item.type === 'business_step_section';
}

function isPierce(item: RenderItem): boolean {
  if (item.type === 'permission_request' || item.type === 'ask_user') return true;
  if (item.type === 'file_download' && item.artifactId) return true;
  if (item.type === 'user' && item.status === 'queued') return true;
  if (item.type === 'voice') return true;
  return false;
}

function isProcessItemActive(item: RenderItem): boolean {
  if (item.type === 'activity_group') return item.isActive;
  if (item.type === 'business_step_section') return item.isActive;
  if (item.type === 'text') return Boolean(item.streaming);
  if (item.type === 'runtime_status') return true;
  if (item.type === 'thinking') return Boolean(item.streaming);
  if (item.type === 'subagent') return item.status === 'running';
  if (item.type === 'tool_use') {
    return (
      item.executionStatus === 'running' ||
      Boolean(item.streaming) ||
      (!item.resultReady &&
        item.executionStatus !== 'completed' &&
        item.executionStatus !== 'failed' &&
        item.executionStatus !== 'cancelled')
    );
  }
  return false;
}

function collectActivityLeaves(items: readonly RenderItem[]): MessageItem[] {
  const leaves: MessageItem[] = [];
  for (const item of items) {
    if (item.type === 'activity_group') {
      leaves.push(...item.items);
      continue;
    }
    if (item.type === 'business_step_section') {
      leaves.push(...collectActivityLeaves(item.items));
      continue;
    }
    if (
      item.type === 'thinking' ||
      item.type === 'tool_use' ||
      item.type === 'tool_result' ||
      item.type === 'subagent' ||
      item.type === 'runtime_status'
    ) {
      leaves.push(item);
    }
  }
  return leaves;
}

function countConnectorWrites(items: readonly RenderItem[]): number {
  return collectActivityLeaves(items).filter(
    (item) => item.type === 'tool_use' && item.presentation?.connector?.write,
  ).length;
}

function processTone(items: readonly RenderItem[]): ActivityStatusTone {
  let tone: ActivityStatusTone = 'success';
  for (const item of items) {
    if (item.type !== 'activity_group') continue;
    const summary = selectActivityGroupSummary(item.items, item.isActive);
    if (summary.tone === 'danger') return 'danger';
    if (summary.tone === 'warning') tone = 'warning';
  }
  return tone;
}

export function partitionAssistantTurn(items: readonly RenderItem[]): AssistantTurnPartition {
  const process: RenderItem[] = [];
  const pierce: RenderItem[] = [];
  const keepOut: RenderItem[] = [];
  const final: RenderItem[] = [];
  let seenFinal = false;

  for (const item of items) {
    if (seenFinal) {
      final.push(item);
      continue;
    }
    if (isFinalText(item)) {
      seenFinal = true;
      final.push(item);
      continue;
    }
    if (isKeepOut(item)) {
      keepOut.push(item);
      continue;
    }
    if (isPierce(item)) {
      pierce.push(item);
      continue;
    }
    process.push(item);
  }

  const hasProcess = process.length > 0;
  const hasFinal = final.some(isSettledFinalText);
  const anyActive = process.some(isProcessItemActive);
  const finalStreaming = final.some((item) => isFinalText(item) && Boolean(item.streaming));

  return {
    process,
    pierce,
    keepOut,
    final,
    shouldFold: hasProcess && hasFinal && !anyActive && !finalStreaming,
  };
}

export function selectTurnProcessSummary(processItems: readonly RenderItem[]): TurnProcessSummary {
  const count = processItems.length;
  const durationMs = getActivityDurationMs(collectActivityLeaves(processItems));
  const writeCount = countConnectorWrites(processItems);
  const parts = [`${count} 项`];
  const duration = formatActivityDuration(durationMs);
  if (duration) parts.push(duration);
  if (writeCount > 0) parts.push(`写了 ${writeCount} 项`);
  return {
    count,
    ...(durationMs === undefined ? {} : { durationMs }),
    writeCount,
    title: '过程记录',
    subtitle: parts.join(' · '),
    tone: processTone(processItems),
  };
}
