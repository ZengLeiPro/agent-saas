/** Agent 活动分组：折叠摘要 + 展开后按子项类型逐块渲染。 */
import React, { useState } from 'react';
import { View } from 'react-native';
import type { ActivityGroup, MessageItem, RawPresentationGate } from '@agent/shared';
import { getToolDisplayInfo } from '@agent/shared';
import { spacing } from '../../../theme';
import { AgentActivityShell, type AgentActivityState } from '../AgentActivityShell';
import { SubagentBlock } from './SubagentBlock';
import { SystemTimelineMessage } from './SystemBlocks';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolResultBlock, ToolUseBlock } from './ToolBlock';

// --- Activity Group ---
interface SummaryInfo {
  text: string;
  ellipsizeMode: 'head' | 'tail';
}

function getSummary(item: MessageItem): SummaryInfo {
  switch (item.type) {
    case 'thinking':
      return { text: item.streaming ? '思考中...' : '已思考', ellipsizeMode: 'tail' };
    case 'tool_use': {
      const info = getToolDisplayInfo(item.toolName, item.toolInput);
      const label = info.detail ? `${info.name}: ${info.detail}` : info.name;
      const text = item.streaming ? `${label}...` : label;
      return { text, ellipsizeMode: info.detailTruncate === 'start' ? 'head' : 'tail' };
    }
    case 'tool_result':
      return { text: `Result: ${item.toolName}`, ellipsizeMode: 'tail' };
    case 'subagent':
      return {
        text:
          item.status === 'running' ? `子任务 ${item.agentType}...` : `子任务 ${item.agentType}`,
        ellipsizeMode: 'tail',
      };
    case 'runtime_status':
      return { text: item.content ?? item.status, ellipsizeMode: 'tail' };
    default:
      return { text: '', ellipsizeMode: 'tail' };
  }
}

function renderActivityItem(item: MessageItem) {
  switch (item.type) {
    case 'thinking':
      return <ThinkingBlock key={item.id} message={item as MessageItem & { type: 'thinking' }} />;
    case 'tool_use':
      return <ToolUseBlock key={item.id} message={item as MessageItem & { type: 'tool_use' }} />;
    case 'tool_result':
      return (
        <ToolResultBlock key={item.id} message={item as MessageItem & { type: 'tool_result' }} />
      );
    case 'subagent':
      return <SubagentBlock key={item.id} message={item as MessageItem & { type: 'subagent' }} />;
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
  const lastItem = group.items[group.items.length - 1];
  const summary = getSummary(lastItem);
  const hasFailure = group.items.some(
    (item) =>
      (item.type === 'tool_use' && item.executionStatus === 'failed') ||
      (item.type === 'subagent' && (item.status === 'failed' || item.status === 'timeout')),
  );
  const state: AgentActivityState = group.isActive
    ? 'running'
    : hasFailure
      ? 'warning'
      : 'completed';

  return (
    <AgentActivityShell
      state={state}
      title="Agent 活动"
      subtitle={summary.text}
      meta={`${group.items.length} 项`}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <View style={{ gap: spacing.xs }}>
        {group.items.map((item) =>
          item.type === 'tool_use' ? (
            <ToolUseBlock
              key={item.id}
              message={item}
              gate={gate}
              onRecovery={onRetry ? () => onRetry(item) : undefined}
            />
          ) : (
            renderActivityItem(item)
          ),
        )}
      </View>
    </AgentActivityShell>
  );
}
