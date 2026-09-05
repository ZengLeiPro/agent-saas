/**
 * 企业专家目录卡 —— 对齐 Web `CapabilityCenter/index.tsx` 专家页的卡片结构：
 * 名称 + 「组织指派」标识 → 职责描述 → 起手任务预览 → 页脚（固有技能数 | 开始对话）。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { OrgAgentSummary } from '@agent/shared';
import { Button } from '../ui';
import { radius, spacing, typography, useColors } from '../../theme';

/** 与 Web 一致：卡片上最多预览 2 条起手任务 */
const STARTER_PREVIEW = 2;

export interface ExpertCardProps {
  expert: OrgAgentSummary;
  disabled?: boolean;
  onStart: (expertId: string) => void;
  testID?: string;
}

export function ExpertCard({ expert, disabled = false, onStart, testID }: ExpertCardProps) {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          backgroundColor: colors.card,
          borderRadius: radius.xl,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          padding: spacing.lg,
          gap: spacing.sm,
        },
        name: { ...typography.subtitle, color: colors.foreground },
        assigned: { ...typography.meta, color: colors.brand[600], fontWeight: '500' },
        description: { ...typography.caption, color: colors.mutedForeground },
        prompts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
        prompt: {
          ...typography.meta,
          color: colors.mutedForeground,
          backgroundColor: colors.muted,
          borderRadius: radius.md,
          paddingHorizontal: spacing.sm,
          paddingVertical: 2,
          overflow: 'hidden',
        },
        footer: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          paddingTop: spacing.md,
        },
        skills: { ...typography.caption, color: colors.mutedForeground, flex: 1 },
      }),
    [colors],
  );

  return (
    <View style={styles.card} testID={testID}>
      <Text style={styles.name} numberOfLines={1}>
        {expert.name}
      </Text>
      <Text style={styles.assigned}>组织指派</Text>
      <Text style={styles.description} numberOfLines={3}>
        {expert.description || '由组织统一配置的企业专家，在限定职责范围内协助你完成工作。'}
      </Text>
      {expert.starterPrompts.length > 0 ? (
        <View style={styles.prompts}>
          {expert.starterPrompts.slice(0, STARTER_PREVIEW).map((prompt) => (
            <Text key={prompt} style={styles.prompt} numberOfLines={1}>
              {prompt}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={styles.footer}>
        <Text style={styles.skills}>
          {expert.skillCount > 0 ? `${expert.skillCount} 个固有技能` : '专属职责范围'}
        </Text>
        <Button
          label="开始对话"
          size="sm"
          disabled={disabled}
          onPress={() => onStart(expert.id)}
          testID={testID ? `${testID}-start` : undefined}
        />
      </View>
    </View>
  );
}
