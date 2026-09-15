/**
 * Agent 活动分组：折叠摘要 + 展开后按子项类型逐块渲染。
 *
 * 摘要（说哪一句、什么语气、耗时多少、进度到哪）全部取自 `@agent/shared` 的
 * `selectActivityGroupSummary`，与 Web `ActivityGroupBlock.tsx` 同源——折叠行是
 * 非 debug 用户唯一能看到的执行信息，两端说法不一致就是演示事故。
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CircleAlert, CircleCheck, Loader2 } from 'lucide-react-native';
import type { ActivityGroup, MessageItem, RawPresentationGate } from '@agent/shared';
import { formatActivityDuration, selectActivityGroupSummary } from '@agent/shared';
import type { ActivityStatusTone } from '@agent/shared';
import { useColors, spacing, useChatTypography } from '../../../theme';
import { useSpinStyle } from '../../ui';
import Animated from 'react-native-reanimated';
import { AgentActivityShell, type AgentActivityState } from '../AgentActivityShell';
import { SubagentBlock } from './SubagentBlock';
import { SystemTimelineMessage } from './SystemBlocks';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolResultBlock, ToolUseBlock } from './ToolBlock';
import { resolveActivityToneTokens } from './tone';

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

function hasPresentation(item: MessageItem): boolean {
  return (item.type === 'tool_use' || item.type === 'tool_result' || item.type === 'subagent')
    && !!item.presentation;
}

/** 非 debug 折叠叶：与 Web ExecutionHiddenPlaceholder 同文案。 */
export function ExecutionHiddenPlaceholder({
  isActive,
  durationMs,
  hasIssue,
}: {
  isActive?: boolean;
  durationMs?: number;
  hasIssue?: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const duration = !isActive ? formatActivityDuration(durationMs) : null;
  const tone: ActivityStatusTone = isActive ? 'active' : hasIssue ? 'warning' : 'success';
  const tint = resolveActivityToneTokens(tone, colors).tint;
  const spin = useSpinStyle(!!isActive);
  const label = isActive
    ? '正在执行中'
    : hasIssue
      ? (duration ? `已执行，有异常 ${duration}` : '已执行，有异常')
      : (duration ? `已执行 ${duration}` : '已执行');
  const icon = isActive
    ? <Animated.View style={spin}><Loader2 size={14} color={tint} strokeWidth={2} /></Animated.View>
    : hasIssue
      ? <CircleAlert size={14} color={tint} strokeWidth={2} />
      : <CircleCheck size={14} color={tint} strokeWidth={2} />;
  return (
    <View style={styles.placeholder} accessibilityRole="summary" accessibilityLabel={label}>
      {icon}
      <Text style={[typo.bodySmall, { color: tint }]}>{label}</Text>
    </View>
  );
}

function renderActivityItem(
  item: MessageItem,
  gate: RawPresentationGate | undefined,
  debugMode: boolean,
  onRetry?: (message: MessageItem) => void,
) {
  switch (item.type) {
    case 'thinking':
      if (!debugMode) {
        return (
          <ExecutionHiddenPlaceholder
            key={item.id}
            isActive={item.streaming}
            durationMs={item.durationMs}
          />
        );
      }
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
      if (!debugMode && !item.presentation) {
        return <ExecutionHiddenPlaceholder key={item.id} />;
      }
      return <ToolResultBlock key={item.id} message={item} gate={gate} />;
    case 'subagent':
      if (!debugMode && !item.presentation) {
        return (
          <ExecutionHiddenPlaceholder
            key={item.id}
            isActive={item.status === 'running'}
            durationMs={item.durationMs}
            hasIssue={item.status === 'failed' || item.status === 'timeout'}
          />
        );
      }
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

  // 调试视图允许单项摘要直接呈现；非调试视图必须经过固定状态分流，避免泄露工具标题。
  if (debugMode && group.items.length === 1 && hasPresentation(group.items[0])) {
    return (
      <View>
        {renderActivityItem(group.items[0], gate, debugMode, onRetry)}
      </View>
    );
  }

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
      expanded={debugMode && expanded}
      disabled={!debugMode}
      onToggle={() => setExpanded((value) => !value)}
    >
      <View style={{ gap: spacing.xs }}>
        {group.items.map((item) => renderActivityItem(item, gate, debugMode, onRetry))}
      </View>
    </AgentActivityShell>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
});
