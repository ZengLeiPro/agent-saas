import { useState, memo } from 'react';
import { StatusIcons } from '@/lib/icons';
import type { MessageItem } from './types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolBlock, ToolResultBlock } from './ToolBlock';
import { SubagentBlock } from './SubagentBlock';
import { RuntimeStatusBlock } from './RuntimeStatusBlock';
import { AgentActivityShell, type AgentActivityState } from './AgentActivityShell';
import { activityStatusIconClass, activityStatusTextClass, formatActivityDuration, type ActivityStatusTone } from './activityStatusStyles';
import { cn } from '@/lib/utils';

interface GroupSummaryInfo {
  text: string;
  tone: ActivityStatusTone;
  durationMs?: number;
  progress?: string;
  active: boolean;
}

function getRuntimeStatusLabel(status: Extract<MessageItem, { type: 'runtime_status' }>['status']): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '思考中';
    case 'waiting_approval':
      return '等待授权';
    case 'waiting_user':
      return '等待补充信息';
    default:
      return '执行中';
  }
}

function isWaitingForUserAction(item: MessageItem): boolean {
  return item.type === 'runtime_status' && (item.status === 'waiting_approval' || item.status === 'waiting_user');
}

function isActiveActivity(item: MessageItem): boolean {
  if (item.type === 'runtime_status') return true;
  if (item.type === 'thinking') return Boolean(item.streaming);
  if (item.type === 'subagent') return item.status === 'running';
  if (item.type === 'tool_use') {
    if (item.executionStatus === 'running' || item.streaming) return true;
    return !item.resultReady && item.executionStatus !== 'completed' && item.executionStatus !== 'failed' && item.executionStatus !== 'cancelled';
  }
  return false;
}

function getActiveItemIndex(items: MessageItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (isWaitingForUserAction(items[i])) return i;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    if (isActiveActivity(items[i])) return i;
  }
  return Math.max(0, items.length - 1);
}

function getActivityDurationMs(items: MessageItem[]): number | undefined {
  let total = 0;
  let hasDuration = false;
  for (const item of items) {
    if ((item.type === 'thinking' || item.type === 'tool_use' || item.type === 'subagent') && typeof item.durationMs === 'number') {
      total += item.durationMs;
      hasDuration = true;
    }
  }
  return hasDuration ? total : undefined;
}

function hasPresentation(item: MessageItem): boolean {
  return (item.type === 'tool_use' || item.type === 'tool_result' || item.type === 'subagent') && !!item.presentation;
}

function getCompletedGroupTitle(items: MessageItem[]): string {
  const titles = items.flatMap((item) => (
    (item.type === 'tool_use' || item.type === 'tool_result' || item.type === 'subagent') && item.presentation?.title
      ? [item.presentation.title]
      : []
  )).filter((title, index, all) => all.indexOf(title) === index);
  if (titles.length === 0) return '已运行';

  const shown: string[] = [];
  for (const title of titles) {
    if (shown.length > 0 && [...shown, title].join('、').length > 42) break;
    shown.push(title);
  }
  return `${shown.join('、')}${shown.length < titles.length ? ' 等' : ''}`;
}

function getActiveGroupSummary(items: MessageItem[]): GroupSummaryInfo {
  const index = getActiveItemIndex(items);
  const item = items[index];
  const progress = `${index + 1}/${items.length}`;

  if (item.type === 'runtime_status') {
    if (item.status === 'waiting_approval' || item.status === 'waiting_user') {
      return {
        text: getRuntimeStatusLabel(item.status),
        tone: 'warning',
        progress,
        active: false,
      };
    }
    if (item.status === 'queued') {
      return {
        text: getRuntimeStatusLabel(item.status),
        tone: 'pending',
        progress,
        active: false,
      };
    }
    return {
      text: getRuntimeStatusLabel(item.status),
      tone: 'active',
      progress,
      active: true,
    };
  }

  if (item.type === 'thinking') {
    return {
      text: '思考中',
      tone: 'active',
      progress,
      active: true,
    };
  }

  return {
    text: '执行中',
    tone: 'active',
    progress,
    active: true,
  };
}

function getGroupSummary(items: MessageItem[], isActive: boolean, debugMode: boolean): GroupSummaryInfo {
  if (isActive) return getActiveGroupSummary(items);

  const cancelledCount = items.filter(item => (
    (item.type === 'tool_use' && item.executionStatus === 'cancelled')
    || (item.type === 'subagent' && item.status === 'cancelled')
  )).length;
  if (cancelledCount > 0) {
    return {
      text: `已取消 ${cancelledCount} 条 · 共 ${items.length} 条`,
      tone: 'neutral',
      durationMs: getActivityDurationMs(items),
      active: false,
    };
  }

  // 非调试视图只展示固定状态，不能把自动生成的工具标题误当成业务摘要。
  return {
    text: debugMode ? getCompletedGroupTitle(items) : '已运行',
    tone: 'success',
    durationMs: getActivityDurationMs(items),
    active: false,
  };
}

function ActivityItem({ item, debugMode = true }: { item: MessageItem; debugMode?: boolean }) {
  switch (item.type) {
    case 'runtime_status':
      return <RuntimeStatusBlock status={item.status} content={item.content} />;
    case 'thinking':
      if (!debugMode) return <ExecutionHiddenPlaceholder isActive={item.streaming} durationMs={item.durationMs} />;
      return <ThinkingBlock content={item.content} streaming={item.streaming} durationMs={item.durationMs} />;
    case 'tool_use':
      if (!debugMode && !item.presentation) {
        return <ExecutionHiddenPlaceholder isActive={item.streaming || item.executionStatus === 'running'} durationMs={item.durationMs} hasIssue={item.executionStatus === 'failed'} />;
      }
      return <ToolBlock toolName={item.toolName} toolInput={item.toolInput} streaming={item.streaming} result={item.result} resultReady={item.resultReady} executionStatus={item.executionStatus} durationMs={item.durationMs} lastProgress={item.lastProgress} error={item.error} {...(item.presentation ? { presentation: item.presentation } : {})} debugMode={debugMode} />;
    case 'tool_result':
      if (!debugMode && !item.presentation) return <ExecutionHiddenPlaceholder />;
      return <ToolResultBlock toolName={item.toolName} result={item.result} {...(item.presentation ? { presentation: item.presentation } : {})} debugMode={debugMode} />;
    case 'subagent':
      if (!debugMode && !item.presentation) return <ExecutionHiddenPlaceholder isActive={item.status === 'running'} durationMs={item.durationMs} hasIssue={item.status === 'failed' || item.status === 'timeout'} />;
      return <SubagentBlock {...item} />;
    default:
      return null;
  }
}

interface ActivityGroupBlockProps {
  items: MessageItem[];
  isActive: boolean;
  isLast?: boolean;
  debugMode?: boolean;
  /** 透传给折叠行外壳。业务步骤节内传 mb-0 抵消轮间场景的 mb-3 补偿。 */
  className?: string;
}

export function ExecutionHiddenPlaceholder({ isActive, durationMs, hasIssue }: { isActive?: boolean; durationMs?: number; hasIssue?: boolean }) {
  const duration = !isActive ? formatActivityDuration(durationMs) : null;
  const tone = isActive ? 'active' : hasIssue ? 'warning' : 'success';
  return (
    <div className="my-1 flex items-center gap-2 py-1 text-sm leading-5 text-muted-foreground">
      {isActive ? (
        <StatusIcons.running className={activityStatusIconClass("active", "size-3.5 shrink-0 animate-spin")} />
      ) : hasIssue ? (
        <StatusIcons.error className={activityStatusIconClass("warning", "size-3.5 shrink-0")} />
      ) : (
        <StatusIcons.success className={activityStatusIconClass("success", "size-3.5 shrink-0")} />
      )}
      <span className={activityStatusTextClass(tone)}>{isActive ? "正在执行中" : hasIssue ? duration ? `已执行，有异常 ${duration}` : "已执行，有异常" : duration ? `已执行 ${duration}` : "已执行"}</span>
    </div>
  );
}

export const ActivityGroupBlock = memo(function ActivityGroupBlock({ items, isActive, debugMode = true, className }: ActivityGroupBlockProps) {
  // 折叠行已提供分组摘要，具体工具详情由用户按需展开，避免长会话默认铺满执行细节。
  const [isExpanded, setIsExpanded] = useState(false);

  // 调试视图允许单项摘要直接呈现；非调试视图必须经过固定状态分流，避免泄露工具标题。
  if (debugMode && items.length === 1 && hasPresentation(items[0])) {
    // 单条业务摘要虽直接展示 ToolBlock，也必须保留与普通活动壳一致的轮间节奏；
    // 否则上一壳的 mb-3 与 ToolBlock 自身 my-0.5 会形成「上 12px / 下 2px」。
    return (
      <div className={cn('mb-3', className)}>
        <ActivityItem item={items[0]} debugMode={debugMode} />
      </div>
    );
  }

  const summary = getGroupSummary(items, isActive, debugMode);
  const state: AgentActivityState = summary.tone === 'active'
    ? 'running'
    : summary.tone === 'warning'
      ? 'warning'
      : summary.tone === 'pending'
        ? 'waiting'
        : summary.tone === 'neutral'
          ? 'cancelled'
          : 'completed';
  const meta = [
    !summary.active ? formatActivityDuration(summary.durationMs) : undefined,
    summary.progress,
    `${items.length} 项`,
  ].filter(Boolean).join(' · ');

  return (
    <AgentActivityShell
      state={state}
      // 摘要即标题：「Agent 活动」这个泛化标题信息量为零，折叠行直接说发生了什么。
      title={summary.text}
      meta={meta}
      expanded={debugMode && isExpanded}
      disabled={!debugMode}
      onToggle={() => setIsExpanded((value) => !value)}
      className={className}
    >
      <div className="flex flex-col gap-3 [&>*]:my-0">
        {items.map(item => (
          <ActivityItem key={item.id} item={item} debugMode={debugMode} />
        ))}
      </div>
    </AgentActivityShell>
  );
});
