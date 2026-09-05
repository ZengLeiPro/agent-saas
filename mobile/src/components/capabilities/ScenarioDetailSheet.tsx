/**
 * 工作流详情 —— 用 `ui/BottomSheet` 承载 Web `ScenarioDetailDialog` 的内容结构：
 * 徽标行（主类型 / 就绪度）→ 标题 + 价值 → 替谁解决什么 / 业务事件 / 读取来源 /
 * 判断与不确定项 / 实际动作 / 人工确认 / 前后对比 → 底部动作（看演示 / 试一试）。
 *
 * 就绪度决定主动作（与 Web 一致）：D2 预约落地诊断、D1 接入我的系统、D0 立即试一试。
 */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CatalogScenarioPublic } from '@agent/shared';
import { Badge, BottomSheet, Button } from '../ui';
import { radius, spacing, typography, useColors } from '../../theme';
import { PRIMARY_TYPE_LABEL, READINESS_LABEL } from '../../lib/capabilities/workflowFilters';

export type WorkflowDetailAction = 'chat' | 'connector' | 'diagnosis' | 'presentation';

export interface ScenarioDetailSheetProps {
  scenario: CatalogScenarioPublic | null;
  roleLabels?: Record<string, string>;
  onClose: () => void;
  onAction: (action: WorkflowDetailAction, scenario: CatalogScenarioPublic) => void;
}

/** 就绪度 → 主动作，与 Web `ScenarioDetailDialog` 的 effectiveCta 一致。 */
export function primaryActionFor(readiness: CatalogScenarioPublic['readiness']): {
  action: WorkflowDetailAction;
  label: string;
} {
  if (readiness === 'D2_PROJECT') return { action: 'diagnosis', label: '预约落地诊断' };
  if (readiness === 'D1_CONNECTOR') return { action: 'connector', label: '接入我的系统' };
  return { action: 'chat', label: '立即试一试' };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={[typography.bodySmall, { color: colors.foreground, fontWeight: '600' }]}>
        {title}
      </Text>
      {children}
    </View>
  );
}

export function ScenarioDetailSheet({
  scenario,
  roleLabels,
  onClose,
  onAction,
}: ScenarioDetailSheetProps) {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.lg },
        badges: { flexDirection: 'row', gap: spacing.sm },
        title: { ...typography.title, color: colors.foreground },
        value: { ...typography.bodySmall, color: colors.mutedForeground },
        text: { ...typography.bodySmall, color: colors.mutedForeground },
        listRow: { flexDirection: 'row', gap: spacing.sm },
        listIndex: {
          ...typography.meta,
          color: colors.secondaryForeground,
          backgroundColor: colors.secondary,
          borderRadius: radius.full,
          minWidth: spacing.xl,
          textAlign: 'center',
          paddingVertical: 2,
          overflow: 'hidden',
        },
        actions: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
        action: { flex: 1 },
      }),
    [colors],
  );

  if (!scenario) return null;
  const primary = primaryActionFor(scenario.readiness);
  const roleNames = scenario.roleIds.map((id) => roleLabels?.[id] ?? id);

  return (
    <BottomSheet visible onClose={onClose} snap="full" testID="workflow-detail-sheet">
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.badges}>
          <Badge label={PRIMARY_TYPE_LABEL[scenario.primaryType]} variant="secondary" />
          <Badge label={READINESS_LABEL[scenario.readiness]} variant="outline" />
        </View>
        <View style={{ gap: spacing.xs }}>
          <Text style={styles.title}>{scenario.title}</Text>
          <Text style={styles.value}>{scenario.value}</Text>
        </View>

        <Section title="替谁解决什么">
          <Text style={styles.text}>涉及岗位：{roleNames.join('、')}</Text>
        </Section>
        <Section title="业务事件">
          <Text style={styles.text}>{scenario.detail.event}</Text>
        </Section>
        <Section title="读取来源">
          {scenario.detail.reads.map((item) => (
            <Text key={item} style={styles.text}>
              · {item}
            </Text>
          ))}
        </Section>
        <Section title="判断与不确定项">
          <Text style={styles.text}>{scenario.detail.decides}</Text>
        </Section>
        <Section title="实际动作">
          {scenario.detail.acts.map((item, index) => (
            <View key={item} style={styles.listRow}>
              <Text style={styles.listIndex}>{index + 1}</Text>
              <Text style={[styles.text, { flex: 1 }]}>{item}</Text>
            </View>
          ))}
        </Section>
        <Section title="人工确认">
          <Text style={styles.text}>{scenario.detail.approval}</Text>
        </Section>
        <Section title="前后对比">
          <Text style={styles.text}>{scenario.detail.beforeAfter}</Text>
          <Text style={styles.text}>{scenario.detail.valueProof}</Text>
        </Section>

        <View style={styles.actions}>
          <Button
            label="看演示"
            variant="secondary"
            style={styles.action}
            onPress={() => onAction('presentation', scenario)}
            testID="workflow-detail-replay"
          />
          <Button
            label={primary.label}
            variant="primary"
            style={styles.action}
            onPress={() => onAction(primary.action, scenario)}
            testID="workflow-detail-primary"
          />
        </View>
      </ScrollView>
    </BottomSheet>
  );
}
