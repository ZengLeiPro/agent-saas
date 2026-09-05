/**
 * V3 工作流目录卡 —— 对齐 Web `scenarios/WorkflowScenarioCard.tsx` 的信息结构：
 * 标题行（左：名称，右：目标词）→ 岗位行 → hairline 页脚（触发时机 | 演示 / 试试）。
 *
 * 与 Web 一致：整卡可点进详情；两个动作同级同形，只用色相区分
 * （演示=品牌暖橙 brandAccent，试试=品牌蓝 brand）；卡内不出现第三种颜色。
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Play } from 'lucide-react-native';
import type { CatalogScenarioPublic } from '@agent/shared';
import { useColors, radius, spacing, typography } from '../../theme';

/** 岗位行最多直接列出的数量，超出折成「+N」（与 Web ROLE_PREVIEW_COUNT 一致） */
const ROLE_PREVIEW_COUNT = 3;
const PRESSED_OPACITY = 0.75;
const ACTION_ICON = 14;

export interface WorkflowCardProps {
  scenario: CatalogScenarioPublic;
  /** 岗位 id → 展示名；缺失时回退到 id */
  roleLabels?: Record<string, string>;
  onOpenDetail: (scenario: CatalogScenarioPublic) => void;
  onReplay: (scenario: CatalogScenarioPublic) => void;
  onTry: (scenario: CatalogScenarioPublic) => void;
  testID?: string;
}

export function WorkflowCard({
  scenario,
  roleLabels,
  onOpenDetail,
  onReplay,
  onTry,
  testID,
}: WorkflowCardProps) {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          borderRadius: radius['2xl'],
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.brand[100],
          backgroundColor: colors.card,
          padding: spacing.lg,
          gap: spacing.sm,
        },
        pressed: { opacity: PRESSED_OPACITY },
        titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
        title: { ...typography.subtitle, color: colors.foreground, flex: 1 },
        goal: { ...typography.caption, color: colors.brand[700], fontWeight: '500' },
        roles: { ...typography.caption, color: colors.mutedForeground },
        footer: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          paddingTop: spacing.md,
          marginTop: spacing.xs,
        },
        trigger: { ...typography.meta, color: colors.mutedForeground, flex: 1 },
        action: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.xs,
          borderRadius: radius.full,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.xs,
        },
        replay: { backgroundColor: colors.brandAccent.soft },
        replayText: { ...typography.caption, color: colors.brandAccent.ink, fontWeight: '500' },
        try: { backgroundColor: colors.brand[50] },
        tryText: { ...typography.caption, color: colors.brand[700], fontWeight: '500' },
      }),
    [colors],
  );

  const goal = scenario.goalTags[0];
  const roleNames = scenario.roleIds.map((id) => roleLabels?.[id] ?? id);
  const hiddenRoles = roleNames.length - ROLE_PREVIEW_COUNT;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`查看 ${scenario.title} 详情`}
      onPress={() => onOpenDetail(scenario)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={2}>
          {scenario.title}
        </Text>
        {goal ? <Text style={styles.goal}>{goal}</Text> : null}
      </View>
      <Text style={styles.roles} numberOfLines={1}>
        {roleNames.slice(0, ROLE_PREVIEW_COUNT).join(' · ')}
        {hiddenRoles > 0 ? ` +${hiddenRoles}` : ''}
      </Text>
      <View style={styles.footer}>
        <Text style={styles.trigger} numberOfLines={1}>
          触发 · {scenario.triggerBadge}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`观看 ${scenario.title} 演示`}
          testID={testID ? `${testID}-replay` : undefined}
          onPress={() => onReplay(scenario)}
          style={({ pressed }) => [styles.action, styles.replay, pressed && styles.pressed]}
        >
          <Play size={ACTION_ICON} color={colors.brandAccent.ink} strokeWidth={2} />
          <Text style={styles.replayText}>演示</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`试一试 ${scenario.title}`}
          testID={testID ? `${testID}-try` : undefined}
          onPress={() => onTry(scenario)}
          style={({ pressed }) => [styles.action, styles.try, pressed && styles.pressed]}
        >
          <Text style={styles.tryText}>试一试</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}
