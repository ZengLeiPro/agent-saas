/**
 * 业务步骤入口：把 business_step 事件与 business_step_section 分派到对应视图。
 *
 * 与 Web 同一条纪律（08-03~04 已上生产）：
 * 步骤从「开始」即出现 → 过程归属其下 → 完成后折起过程只留一句业务结果。
 * 原始 input/result 的可见性仍然只由 RawPresentationGate 决定，本文件不开旁路。
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import type {
  BusinessStepEventItem,
  BusinessStepSection,
  RawPresentationGate,
  RenderItem,
} from '@agent/shared';
import { selectBusinessStepPresentation, todoStatusMeta } from '@agent/shared';
import { useColors, spacing, radius, fontWeight, useChatTypography } from '../../../theme';
import { Badge } from '../../ui';
import { CanonicalPresentationBody } from './PresentationBlock';
import { BusinessStepFlow, BusinessStepPlanUpdate } from './BusinessStepFlow';
import { BusinessStepResultContent } from './BusinessStepDetailSheet';
import { BusinessStepStatusIcon } from './BusinessStepTimeline';
import { toneBadgeVariant } from './tone';

export type BusinessStepRenderItem = (item: RenderItem) => React.ReactNode;

/**
 * 步骤节：一步的完整叙事单元。
 *
 * 终态后过程整体收起（客户只要结论），但 `systemActionIds` 标记的外部系统写操作
 * 继续留痕——「AI 动了客户自己的系统」不是技术噪音，是这条产品线的核心可见性。
 */
export function BusinessStepSectionView({
  section,
  renderItem,
}: {
  section: BusinessStepSection;
  renderItem?: BusinessStepRenderItem;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const [expanded, setExpanded] = useState(false);

  const todo = section.terminal?.todo ?? section.start.todo;
  const meta = todo ? todoStatusMeta(todo) : null;
  const terminal = !!section.terminal;
  const systemActionIds = useMemo(
    () => new Set(section.systemActionIds ?? []),
    [section.systemActionIds],
  );
  const pinnedItems = useMemo(
    () => (terminal ? section.items.filter((item) => systemActionIds.has(item.id)) : []),
    [section.items, systemActionIds, terminal],
  );
  // 终态前过程直接在流里生长；终态后折起，展开才回放全过程。
  const inlineItems = terminal ? (expanded ? section.items : pinnedItems) : section.items;

  return (
    <View style={[styles.section, { borderLeftColor: colors.border }]}>
      <View style={styles.sectionHeader}>
        {todo ? <BusinessStepStatusIcon todo={todo} /> : null}
        <Text
          numberOfLines={2}
          style={[
            typo.bodySmall,
            styles.flexText,
            { color: colors.foreground, fontWeight: fontWeight.semibold },
          ]}
        >
          {todo?.content ?? '业务步骤'}
        </Text>
        {meta ? <Badge size="sm" variant={toneBadgeVariant(meta.tone)} label={meta.label} /> : null}
      </View>
      {section.resumePending ? (
        <Text style={[typo.caption, { color: colors.mutedForeground }]}>等待恢复执行</Text>
      ) : null}
      {terminal && todo ? (
        <BusinessStepResultContent todo={todo} processAnomaly={section.processAnomaly} />
      ) : null}
      {terminal && section.items.length > 0 ? (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded ? '收起过程' : '展开过程'}
          style={styles.processToggle}
        >
          <Text style={[typo.caption, { color: colors.mutedForeground }]}>
            {`过程 · ${section.items.length} 项`}
          </Text>
          <ChevronRight
            size={14}
            color={colors.mutedForeground}
            style={expanded ? styles.rotated : undefined}
          />
        </Pressable>
      ) : null}
      {renderItem && inlineItems.length > 0 ? (
        <View style={styles.processBody}>
          {inlineItems.map((item) => (
            <View key={item.id}>{renderItem(item)}</View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * 单条步骤事件（未开启章节化，或没有对应开放节的孤立终态）。
 * 走 canonical presenter，与工具块 / 错误块共用同一套安全边界。
 */
export function BusinessStepCard({
  event,
  gate,
}: {
  event: BusinessStepEventItem;
  gate?: RawPresentationGate;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const presentation = useMemo(() => selectBusinessStepPresentation(event, gate), [event, gate]);

  if (event.kind === 'plan') return <BusinessStepFlow event={event} />;
  if (event.kind === 'update') return <BusinessStepPlanUpdate event={event} />;

  return (
    <View
      accessibilityRole={presentation.tone === 'danger' ? 'alert' : 'summary'}
      accessibilityLabel={[presentation.title, presentation.statusLabel, presentation.summary]
        .filter(Boolean)
        .join('，')}
      accessibilityLiveRegion={presentation.tone === 'danger' ? 'assertive' : 'polite'}
      style={[styles.card, { borderColor: colors.border }]}
    >
      <View style={styles.cardHeader}>
        <Text
          style={[
            typo.bodySmall,
            styles.flexText,
            { color: colors.foreground, fontWeight: fontWeight.semibold },
          ]}
        >
          {presentation.title}
        </Text>
        <Badge
          size="sm"
          variant={toneBadgeVariant(presentation.tone === 'danger' ? 'danger' : 'neutral')}
          label={presentation.statusLabel}
        />
      </View>
      <CanonicalPresentationBody presentation={presentation} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderLeftWidth: 2,
    paddingLeft: spacing.sm,
    gap: spacing.sm,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  processToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
    alignSelf: 'flex-start',
  },
  processBody: { gap: spacing.xs },
  rotated: { transform: [{ rotate: '90deg' }] },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flexText: { flex: 1, minWidth: 0 },
});
