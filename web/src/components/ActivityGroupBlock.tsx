import { useState, memo } from 'react';
import { ChevronRight } from 'lucide-react';
import { StatusIcons } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { getToolDisplayInfo } from '@agent/shared';
import type { MessageItem } from './types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolBlock, ToolResultBlock } from './ToolBlock';
import { SubagentBlock } from './SubagentBlock';
import { RuntimeStatusBlock } from './RuntimeStatusBlock';
import { activityStatusBadgeClass, activityStatusIconClass, activityStatusTextClass, formatActivityDuration, type ActivityStatusTone } from './activityStatusStyles';

interface SummaryInfo {
  text: string;
  truncateStart: boolean;
}

interface GroupSummaryInfo extends SummaryInfo {
  tone: ActivityStatusTone;
  badge: string;
  durationMs?: number;
  progress?: string;
  active: boolean;
}

/** 根据最后一条消息生成摘要文字及截断方向 */
function getSummary(item: MessageItem): SummaryInfo {
  switch (item.type) {
    case 'runtime_status':
      return { text: item.content || '正在处理', truncateStart: false };
    case 'thinking':
      return { text: item.streaming ? '思考中...' : '已思考', truncateStart: false };
    case 'tool_use': {
      const info = getToolDisplayInfo(item.toolName, item.toolInput);
      const label = info.detail ? `${info.name}: ${info.detail}` : info.name;
      const text = item.streaming ? `${label}...` : label;
      return { text, truncateStart: info.detailTruncate === 'start' };
    }
    case 'tool_result':
      return { text: `Result: ${item.toolName}`, truncateStart: false };
    case 'subagent':
      return {
        text: item.status === 'running'
          ? `子任务 ${item.agentType}...`
          : item.status === 'failed'
            ? `子任务未完成：${item.agentType}`
            : item.status === 'timeout'
              ? `子任务超时：${item.agentType}`
              : item.status === 'cancelled'
                ? `子任务已取消：${item.agentType}`
                : `子任务 ${item.agentType}`,
        truncateStart: false,
      };
    default:
      return { text: '', truncateStart: false };
  }
}

function getRuntimeStatusLabel(status: Extract<MessageItem, { type: 'runtime_status' }>['status']): string {
  switch (status) {
    case 'sending':
      return '正在发送消息';
    case 'queued':
      return '已进入队列';
    case 'running':
      return '正在思考';
    case 'waiting_hand':
      return '正在准备工作区';
    case 'waiting_approval':
      return '等待授权';
    case 'waiting_user':
      return '等待补充信息';
    case 'reconnecting':
      return '正在恢复连接';
    default:
      return '正在处理';
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

function getCompletedBreakdown(items: MessageItem[]): string {
  const thinkingCount = items.filter(item => item.type === 'thinking').length;
  const toolCount = items.filter(item => item.type === 'tool_use').length;
  const subagentCount = items.filter(item => item.type === 'subagent').length;
  const parts = [
    thinkingCount > 0 ? `${thinkingCount} 次思考` : '',
    toolCount > 0 ? `${toolCount} 个工具` : '',
    subagentCount > 0 ? `${subagentCount} 个子任务` : '',
  ].filter(Boolean);
  return parts.length > 0
    ? `已完成 ${items.length} 条：${parts.join(' · ')}`
    : `已完成 ${items.length} 条`;
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

function hasActivityIssue(items: MessageItem[]): boolean {
  return items.some(item => (
    (item.type === 'tool_use' && item.executionStatus === 'failed')
    || (item.type === 'subagent' && (item.status === 'failed' || item.status === 'timeout'))
  ));
}

function getActiveGroupSummary(items: MessageItem[]): GroupSummaryInfo {
  const index = getActiveItemIndex(items);
  const item = items[index];
  const progress = `${index + 1}/${items.length}`;

  if (item.type === 'runtime_status') {
    if (item.status === 'waiting_approval' || item.status === 'waiting_user') {
      return {
        text: item.content || getRuntimeStatusLabel(item.status),
        truncateStart: false,
        tone: 'warning',
        badge: '需处理',
        progress,
        active: false,
      };
    }
    if (item.status === 'queued') {
      return {
        text: item.content || getRuntimeStatusLabel(item.status),
        truncateStart: false,
        tone: 'pending',
        badge: '排队中',
        progress,
        active: false,
      };
    }
    return {
      text: item.content || getRuntimeStatusLabel(item.status),
      truncateStart: false,
      tone: 'active',
      badge: '处理中',
      progress,
      active: true,
    };
  }

  if (item.type === 'thinking') {
    return {
      text: item.streaming ? '思考中...' : '已思考',
      truncateStart: false,
      tone: item.streaming ? 'active' : 'success',
      badge: item.streaming ? '思考中' : '已完成',
      progress,
      active: Boolean(item.streaming),
    };
  }

  if (item.type === 'tool_use') {
    const info = getToolDisplayInfo(item.toolName, item.toolInput);
    const label = info.detail ? `${info.name}: ${info.detail}` : info.name;
    if (item.executionStatus === 'failed') {
      return { text: `未成功：${label}`, truncateStart: info.detailTruncate === 'start', tone: 'warning', badge: '有异常', progress, active: false };
    }
    if (item.executionStatus === 'cancelled') {
      return { text: `已取消：${label}`, truncateStart: info.detailTruncate === 'start', tone: 'neutral', badge: '已取消', progress, active: false };
    }
    if (item.executionStatus === 'completed' || item.resultReady) {
      return { text: `已完成：${label}`, truncateStart: info.detailTruncate === 'start', tone: 'success', badge: '已完成', progress, active: false };
    }
    return { text: `正在执行：${label}`, truncateStart: info.detailTruncate === 'start', tone: 'active', badge: '执行中', progress, active: true };
  }

  if (item.type === 'subagent') {
    if (item.status === 'failed') {
      return { text: `子任务未完成：${item.agentType}`, truncateStart: false, tone: 'warning', badge: '有异常', progress, active: false };
    }
    if (item.status === 'timeout') {
      return { text: `子任务超时：${item.agentType}`, truncateStart: false, tone: 'warning', badge: '超时', progress, active: false };
    }
    if (item.status === 'cancelled') {
      return { text: `子任务已取消：${item.agentType}`, truncateStart: false, tone: 'neutral', badge: '已取消', progress, active: false };
    }
    return {
      text: item.status === 'running' ? `子任务 ${item.agentType}...` : `子任务 ${item.agentType}`,
      truncateStart: false,
      tone: item.status === 'running' ? 'active' : 'success',
      badge: item.status === 'running' ? '执行中' : '已完成',
      progress,
      active: item.status === 'running',
    };
  }

  return {
    ...getSummary(item),
    tone: 'active',
    badge: '处理中',
    progress,
    active: true,
  };
}

function getGroupSummary(items: MessageItem[], isActive: boolean): GroupSummaryInfo {
  if (isActive) {
    const summary = getActiveGroupSummary(items);
    if (summary.badge === '有异常' || summary.badge === '超时') {
      return {
        text: '正在处理',
        truncateStart: false,
        tone: 'active',
        badge: '处理中',
        progress: summary.progress,
        active: true,
      };
    }
    return summary;
  }

  const cancelledCount = items.filter(item => (
    (item.type === 'tool_use' && item.executionStatus === 'cancelled')
    || (item.type === 'subagent' && item.status === 'cancelled')
  )).length;
  if (cancelledCount > 0) {
    return {
      text: `已取消 ${cancelledCount} 条 · 共 ${items.length} 条`,
      truncateStart: false,
      tone: 'neutral',
      badge: '已取消',
      durationMs: getActivityDurationMs(items),
      active: false,
    };
  }

  return {
    text: getCompletedBreakdown(items),
    truncateStart: false,
    tone: 'success',
    badge: '已完成',
    durationMs: getActivityDurationMs(items),
    active: false,
  };
}

function GroupStatusIcon({ summary }: { summary: GroupSummaryInfo }) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (summary.active) {
    return <StatusIcons.running className={activityStatusIconClass("active", `${className} animate-spin`)} />;
  }
  if (summary.tone === 'danger') {
    return <StatusIcons.error className={activityStatusIconClass("danger", className)} />;
  }
  if (summary.tone === 'warning') {
    return <StatusIcons.error className={activityStatusIconClass("warning", className)} />;
  }
  if (summary.tone === 'neutral') {
    return <StatusIcons.cancelled className={activityStatusIconClass("neutral", className)} />;
  }
  if (summary.tone === 'pending') {
    return <StatusIcons.pending className={activityStatusIconClass("pending", className)} />;
  }
  return <StatusIcons.success className={activityStatusIconClass("success", className)} />;
}

function ActivityItem({ item }: { item: MessageItem }) {
  switch (item.type) {
    case 'runtime_status':
      return <RuntimeStatusBlock status={item.status} content={item.content} />;
    case 'thinking':
      return <ThinkingBlock content={item.content} streaming={item.streaming} durationMs={item.durationMs} />;
    case 'tool_use':
      return <ToolBlock toolName={item.toolName} toolInput={item.toolInput} streaming={item.streaming} result={item.result} resultReady={item.resultReady} executionStatus={item.executionStatus} durationMs={item.durationMs} lastProgress={item.lastProgress} error={item.error} />;
    case 'tool_result':
      return <ToolResultBlock toolName={item.toolName} result={item.result} />;
    case 'subagent':
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
}

export function ExecutionHiddenPlaceholder({ isActive, durationMs, hasIssue }: { isActive?: boolean; durationMs?: number; hasIssue?: boolean }) {
  const duration = !isActive ? formatActivityDuration(durationMs) : null;
  const tone = isActive ? 'active' : hasIssue ? 'warning' : 'success';
  return (
    <div className="my-0.5 flex items-center gap-1.5 py-0.5 text-sm text-muted-foreground">
      {isActive ? (
        <StatusIcons.running className={activityStatusIconClass("active", "h-3.5 w-3.5 shrink-0 animate-spin")} />
      ) : hasIssue ? (
        <StatusIcons.error className={activityStatusIconClass("warning", "h-3.5 w-3.5 shrink-0")} />
      ) : (
        <StatusIcons.success className={activityStatusIconClass("success", "h-3.5 w-3.5 shrink-0")} />
      )}
      <span className={activityStatusTextClass(tone)}>{isActive ? "正在执行中" : hasIssue ? duration ? `已执行，有异常 ${duration}` : "已执行，有异常" : duration ? `已执行 ${duration}` : "已执行"}</span>
    </div>
  );
}

export const ActivityGroupBlock = memo(function ActivityGroupBlock({ items, isActive, debugMode = true }: ActivityGroupBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!debugMode) {
    return <ExecutionHiddenPlaceholder isActive={isActive} durationMs={getActivityDurationMs(items)} hasIssue={items.length === 1 && hasActivityIssue(items)} />;
  }

  // 单项分组：直接渲染子项本身（单层展开），不套分组壳
  if (items.length === 1) {
    return <ActivityItem item={items[0]} />;
  }

  const summary = getGroupSummary(items, isActive);
  const summaryDuration = !summary.active ? formatActivityDuration(summary.durationMs) : null;

  return (
    <div className="my-0.5">
      <button
        onClick={() => setIsExpanded(v => !v)}
        className="flex max-w-full items-center gap-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <GroupStatusIcon summary={summary} />
        <span
          className="min-w-0 max-w-sm truncate"
          style={summary.truncateStart ? { direction: 'rtl', textAlign: 'left' } : undefined}
        >{summary.text}</span>
        <span className={activityStatusBadgeClass(summary.tone)}>{summaryDuration ? `${summary.badge} ${summaryDuration}` : summary.badge}</span>
        {summary.progress && <span className="shrink-0 text-muted-foreground/60">({summary.progress})</span>}
        <ChevronRight className={cn(
          "h-3.5 w-3.5 shrink-0 transition-transform",
          isExpanded && "rotate-90",
        )} />
      </button>
      {isExpanded && (
        <div className="ml-5 flex flex-col border-l border-border pl-2 [&>*]:my-0" style={{ gap: 10, paddingTop: 10 }}>
          {items.map(item => (
            <ActivityItem key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
});
