/** 业务步骤卡片：标题 + 状态标签 + canonical 正文。 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { BusinessStepEventItem, RawPresentationGate } from '@agent/shared';
import { selectBusinessStepPresentation } from '@agent/shared';
import { useColors, spacing, typography, radius } from '../../../theme';
import { CanonicalPresentationBody } from './PresentationBlock';

export function BusinessStepCard({
  event,
  gate,
}: {
  event: BusinessStepEventItem;
  gate?: RawPresentationGate;
}) {
  const colors = useColors();
  const presentation = useMemo(() => selectBusinessStepPresentation(event, gate), [event, gate]);
  return (
    <View
      accessibilityRole={presentation.tone === 'danger' ? 'alert' : 'summary'}
      accessibilityLabel={[presentation.title, presentation.statusLabel, presentation.summary]
        .filter(Boolean)
        .join('，')}
      accessibilityLiveRegion={presentation.tone === 'danger' ? 'assertive' : 'polite'}
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        borderRadius: radius.md,
        padding: spacing.sm,
        gap: spacing.xs,
      }}
    >
      <Text style={{ ...typography.bodySmall, fontWeight: '600', color: colors.foreground }}>
        {presentation.title}
      </Text>
      <Text
        style={{
          ...typography.caption,
          color: presentation.tone === 'danger' ? colors.destructive : colors.mutedForeground,
        }}
      >
        {presentation.statusLabel}
      </Text>
      <CanonicalPresentationBody presentation={presentation} />
    </View>
  );
}
