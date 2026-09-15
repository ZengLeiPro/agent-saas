import React, { useState } from 'react';
import { View } from 'react-native';
import type { RenderItem } from '@agent/shared';
import { selectTurnProcessSummary, type ActivityStatusTone } from '@agent/shared';
import { AgentActivityShell, type AgentActivityState } from './AgentActivityShell';
import { spacing } from '../../theme';

function shellState(tone: ActivityStatusTone): AgentActivityState {
  if (tone === 'active') return 'running';
  if (tone === 'warning') return 'warning';
  if (tone === 'pending') return 'waiting';
  if (tone === 'neutral') return 'cancelled';
  if (tone === 'danger') return 'failed';
  return 'completed';
}

export function TurnProcessFold({
  items,
  renderItem,
}: {
  items: RenderItem[];
  renderItem: (item: RenderItem) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = selectTurnProcessSummary(items);

  return (
    <View testID="turn-process-fold">
      <AgentActivityShell
        state={shellState(summary.tone)}
        title={summary.title}
        subtitle={summary.subtitle}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      >
        <View style={{ gap: spacing.xs }}>
          {items.map((item) => (
            <View key={item.id}>{renderItem(item)}</View>
          ))}
        </View>
      </AgentActivityShell>
    </View>
  );
}
