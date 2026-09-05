import { useState, memo } from 'react';
import { StatusIcons } from '@/lib/icons';
import type { MessageItem } from './types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolBlock, ToolResultBlock } from './ToolBlock';
import { SubagentBlock } from './SubagentBlock';
import { RuntimeStatusBlock } from './RuntimeStatusBlock';
import { AgentActivityShell, type AgentActivityState } from './AgentActivityShell';
import { activityStatusIconClass, activityStatusTextClass, formatActivityDuration } from './activityStatusStyles';
import { cn } from '@/lib/utils';
import { selectActivityGroupSummary } from '@agent/shared';

function hasPresentation(item: MessageItem): boolean {
  return (item.type === 'tool_use' || item.type === 'tool_result' || item.type === 'subagent') && !!item.presentation;
}

function ActivityItem({ item, debugMode = true, rawPresentationMode = debugMode, onSwitchModel }: { item: MessageItem; debugMode?: boolean; rawPresentationMode?: boolean; onSwitchModel?: () => void }) {
  switch (item.type) {
    case 'runtime_status':
      return <RuntimeStatusBlock status={item.status} content={item.content} />;
    case 'thinking':
      if (!debugMode) return <ExecutionHiddenPlaceholder isActive={item.streaming} durationMs={item.durationMs} />;
      return <ThinkingBlock content={item.content} streaming={item.streaming} durationMs={item.durationMs} />;
    case 'tool_use':
      return <ToolBlock toolName={item.toolName} toolInput={item.toolInput} streaming={item.streaming} result={item.result} resultReady={item.resultReady} executionStatus={item.executionStatus} durationMs={item.durationMs} lastProgress={item.lastProgress} error={item.error} {...(item.presentation ? { presentation: item.presentation } : {})} debugMode={rawPresentationMode} />;
    case 'tool_result':
      if (!debugMode && !item.presentation) return <ExecutionHiddenPlaceholder />;
      return <ToolResultBlock toolName={item.toolName} result={item.result} {...(item.presentation ? { presentation: item.presentation } : {})} debugMode={rawPresentationMode} />;
    case 'subagent':
      if (!debugMode && !item.presentation) return <ExecutionHiddenPlaceholder isActive={item.status === 'running'} durationMs={item.durationMs} hasIssue={item.status === 'failed' || item.status === 'timeout'} />;
      return <SubagentBlock {...item} onSwitchModel={onSwitchModel} />;
    default:
      return null;
  }
}

interface ActivityGroupBlockProps {
  items: MessageItem[];
  isActive: boolean;
  isLast?: boolean;
  debugMode?: boolean;
  rawPresentationMode?: boolean;
  onSwitchModel?: () => void;
  /** 透传给折叠行外壳（壳自身不带流向外边距，间距由容器 gap 统一承担）。 */
  className?: string;
}

export function ExecutionHiddenPlaceholder({ isActive, durationMs, hasIssue }: { isActive?: boolean; durationMs?: number; hasIssue?: boolean }) {
  const duration = !isActive ? formatActivityDuration(durationMs) : null;
  const tone = isActive ? 'active' : hasIssue ? 'warning' : 'success';
  return (
    <div className="flex items-center gap-2 py-1 text-sm leading-5 text-muted-foreground">
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

export const ActivityGroupBlock = memo(function ActivityGroupBlock({ items, isActive, debugMode = true, rawPresentationMode = debugMode, onSwitchModel, className }: ActivityGroupBlockProps) {
  // 折叠行已提供分组摘要，具体工具详情由用户按需展开，避免长会话默认铺满执行细节。
  const [isExpanded, setIsExpanded] = useState(false);

  // 调试视图允许单项摘要直接呈现；非调试视图必须经过固定状态分流，避免泄露工具标题。
  if (debugMode && items.length === 1 && hasPresentation(items[0])) {
    // 单条业务摘要直接展示 ToolBlock：壳不带外边距，统一节奏只由容器 gap 承担。
    // [&>*]:my-0 继续作为防御性约束，避免后续子组件重新引入流向 margin。
    return (
      <div className={cn('[&>*]:my-0', className)}>
        <ActivityItem item={items[0]} debugMode={debugMode} rawPresentationMode={rawPresentationMode} onSwitchModel={onSwitchModel} />
      </div>
    );
  }

  const summary = selectActivityGroupSummary(items, isActive, debugMode);
  const state: AgentActivityState = summary.tone === 'active'
    ? 'running'
    : summary.tone === 'warning'
      ? 'warning'
      : summary.tone === 'pending'
        ? 'waiting'
        : summary.tone === 'neutral'
          ? 'cancelled'
          : summary.tone === 'danger'
            ? 'failed'
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
      actions={onSwitchModel && items.some((item) => item.type === 'subagent' && item.recoveryAction === 'switch_model') ? <button type="button" onClick={onSwitchModel} className="rounded-md px-2 py-1 text-xs font-medium text-foreground/75 transition-colors hover:bg-muted hover:text-foreground">切换模型</button> : undefined}
      className={className}
    >
      <div className="flex flex-col gap-2 [&>*]:my-0">
        {items.map(item => (
          <ActivityItem key={item.id} item={item} debugMode={debugMode} rawPresentationMode={rawPresentationMode} />
        ))}
      </div>
    </AgentActivityShell>
  );
});
