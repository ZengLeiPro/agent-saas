/** 子任务（subagent）块：活动外壳 + 模型/轮次/工具次数等元信息。 */
import React, { useState } from 'react';
import { View, Text } from 'react-native';
import type { MessageItem } from '@agent/shared';
import { formatTokenCount } from '@agent/shared';
import { useColors, spacing, typography } from '../../../theme';
import { AgentActivityShell, type AgentActivityState } from '../AgentActivityShell';

// --- Subagent Block ---
export function SubagentBlock({ message }: { message: MessageItem & { type: 'subagent' } }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const state: AgentActivityState =
    message.status === 'running'
      ? 'running'
      : message.status === 'completed'
        ? 'completed'
        : message.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
  const meta = [
    message.model,
    typeof message.durationMs === 'number'
      ? `${(message.durationMs / 1000).toFixed(1)}s`
      : undefined,
    typeof message.turnCount === 'number' ? `${message.turnCount} 轮` : undefined,
    typeof message.totalTokens === 'number'
      ? `${formatTokenCount(message.totalTokens)} tokens`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <AgentActivityShell
      state={state}
      title={`子任务 ${message.agentType}`}
      meta={meta || undefined}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <View style={{ gap: spacing.xs }}>
        <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
          {[
            message.model ? `模型 ${message.model}` : undefined,
            typeof message.turnCount === 'number' ? `${message.turnCount} 轮` : undefined,
            typeof message.toolUseCount === 'number' ? `${message.toolUseCount} 次工具` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {message.errorMessage ? (
          <Text style={{ ...typography.caption, color: colors.destructive }}>
            {message.errorMessage}
          </Text>
        ) : null}
        {message.resultPreview ? (
          <Text style={{ ...typography.caption, color: colors.foreground }} numberOfLines={6}>
            {message.resultPreview}
          </Text>
        ) : null}
      </View>
    </AgentActivityShell>
  );
}
