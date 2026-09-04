/**
 * Agent 活动分组：折叠摘要 + 展开后按子项类型逐块渲染。
 *
 * 摘要（说哪一句、什么语气、耗时多少、进度到哪）全部取自 `@agent/shared` 的
 * `selectActivityGroupSummary`，与 Web `ActivityGroupBlock.tsx` 同源——折叠行是
 * 非 debug 用户唯一能看到的执行信息，两端说法不一致就是演示事故。
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import type { ActivityGroup, MessageItem, RawPresentationGate } from '@agent/shared';
import { formatActivityDuration, selectActivityGroupSummary } from '@agent/shared';
import { spacing } from '../../../theme';
import { AgentActivityShell, type AgentActivityState } from '../AgentActivityShell';
import { SubagentBlock } from './SubagentBlock';
import { SystemTimelineMessage } from './SystemBlocks';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolResultBlock, ToolUseBlock } from './ToolBlock';
import type { ActivityStatusTone } from '@agent/shared';

/** 语气 → 活动壳六态。与 Web 的 tone→state 分派一一对应。 */
function shellState(tone: ActivityStatusTone): AgentActivityState {
  switch (tone) {
    case 'active':
      return 'running';
    case 'warning':
      return 'warning';
    case 'pending':
      return 'waiting';
    case 'neutral':
      return 'cancelled';
    case 'danger':
      return 'failed';
    case 'success':
      return 'completed';
  }
}

function renderActivityItem(
  item: MessageItem,
  gate: RawPresentationGate | undefined,
  onRetry?: (message: MessageItem) => void,
) {
  switch (item.type) {
    case 'thinking':
      return <ThinkingBlock key={item.id} message={item} />;
    case 'tool_use':
      return (
        <ToolUseBlock
          key={item.id}
          message={item}
          gate={gate}
          onRecovery={onRetry ? () => onRetry(item) : undefined}
        />
      );
    case 'tool_result':
      return <ToolResultBlock key={item.id} message={item} gate={gate} />;
    case 'subagent':
      return <SubagentBlock key={item.id} message={item} />;
    case 'runtime_status':
      return <SystemTimelineMessage key={item.id} message={item} />;
    default:
      return null;
  }
}

export function ActivityGroupView({
  group,
  gate,
  onRetry,
}: {
  group: ActivityGroup;
  isLast?: boolean;
  gate?: RawPresentationGate;
  onRetry?: (message: MessageItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // debug 权限已由调用方在 gate 上解析完毕；这里只消费结论，不重新判权限。
  const debugMode = gate?.explicitSessionToggle === true || gate?.sessionRawEnabled === true;
  const summary = useMemo(
    () => selectActivityGroupSummary(group.items, group.isActive, debugMode),
    [group.items, group.isActive, debugMode],
  );

  const meta = [
    summary.active ? null : formatActivityDuration(summary.durationMs),
    summary.progress,
    `${group.items.length} 项`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <AgentActivityShell
      // 摘要即标题：「Agent 活动」这个泛化标题信息量为零，折叠行直接说发生了什么。
      state={shellState(summary.tone)}
      title={summary.text}
      meta={meta}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <View style={{ gap: spacing.xs }}>
        {group.items.map((item) => renderActivityItem(item, gate, onRetry))}
      </View>
    </AgentActivityShell>
  );
}
