/**
 * 业务步骤详情 —— 与 `web/src/components/BusinessStepDetailPanel.tsx` 的
 * BusinessStepDetailBody 同构，承载体换成移动端的 `ui/BottomSheet`。
 *
 * 结构与 Web 一致：结果（一句 outcome + 分流标签 + 结构化详情） → 依据。
 * 「过程」不在这里重复：移动端过程随步骤节内联在时间线里（见 BusinessStepBlock），
 * 与 Web「过程折叠在详情面板」是同一条纪律的两种承载。
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { ChevronRight, CircleX, TriangleAlert } from 'lucide-react-native';
import type { OutcomeStat, TodoItem, TodoOutcome } from '@agent/shared';
import {
  migrateLegacySectionVerdicts,
  outcomeToneMeta,
  statVerdict,
  todoStatusMeta,
  visibleOutcomeStats,
} from '@agent/shared';
import { useColors, spacing, radius, fontWeight, useChatTypography } from '../../../theme';
import { Badge, BottomSheet } from '../../ui';
import { DetailLines } from './DetailLines';
import { PresentationBlocks } from './PresentationBlockViews';
import { RecordsBlockView } from './RecordsBlockView';
import { EvidenceRefs } from './PresentationBlock';
import { BusinessStepStatusIcon } from './BusinessStepTimeline';
import { resolveActivityToneTokens, toneBadgeVariant } from './tone';

/** 分流计数标签：判定类（绿/红）与中性计数走两种形态，与 Web StatChip 一致。 */
function StatChip({ stat }: { stat: OutcomeStat }) {
  const colors = useColors();
  const typo = useChatTypography();
  const verdict = statVerdict(stat);
  if (verdict) {
    return (
      <Badge
        size="sm"
        variant={toneBadgeVariant(verdict === 'pass' ? 'success' : 'danger')}
        label={`${stat.label} ${stat.value}`}
      />
    );
  }
  return (
    <Text
      style={[
        typo.meta,
        styles.neutralChip,
        { color: colors.mutedForeground, borderColor: colors.border },
      ]}
    >
      {`${stat.label} `}
      <Text style={{ color: colors.foreground, fontWeight: fontWeight.medium }}>{stat.value}</Text>
    </Text>
  );
}

/** 一句业务结果。完成后折起过程，这一行就是客户唯一要看的东西。 */
export function OutcomeLine({
  outcome,
  stats,
}: {
  outcome: TodoOutcome;
  stats: readonly OutcomeStat[];
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const meta = outcomeToneMeta(outcome);
  const tone = resolveActivityToneTokens(meta.tone, colors);
  const Icon = meta.icon === 'x' ? CircleX : meta.icon === 'alert' ? TriangleAlert : null;
  return (
    <View style={styles.stack}>
      <View style={styles.outcomeRow}>
        {Icon ? (
          <Icon size={14} color={tone.tint} strokeWidth={2} style={styles.outcomeIcon} />
        ) : null}
        <Text
          style={[
            typo.bodySmall,
            styles.flexText,
            { color: meta.icon ? tone.ink : colors.foreground },
          ]}
        >
          {outcome.text}
        </Text>
      </View>
      {stats.length ? (
        <View style={styles.chips}>
          {stats.map((stat) => (
            <StatChip key={`${stat.label}-${stat.value}`} stat={stat} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** 结构化摘要主体：历史「小节 + 判定行」先升格为 checklist，再逐段渲染。 */
function StepSummaryBody({ todo }: { todo: TodoItem }) {
  const parts = useMemo(() => migrateLegacySectionVerdicts(todo.detail), [todo.detail]);
  return (
    <View style={styles.stack}>
      {parts.map((part, index) =>
        part.kind === 'detail' ? (
          <DetailLines key={index} lines={part.lines} />
        ) : (
          <RecordsBlockView key={index} block={part.block} />
        ),
      )}
      {todo.display?.length ? <PresentationBlocks blocks={todo.display} /> : null}
    </View>
  );
}

export function BusinessStepResultContent({
  todo,
  processAnomaly,
}: {
  todo: TodoItem;
  processAnomaly?: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const warn = resolveActivityToneTokens('warning', colors);
  const stats = useMemo(
    () => visibleOutcomeStats(todo.outcome?.stat, todo.detail),
    [todo.outcome?.stat, todo.detail],
  );
  return (
    <View style={styles.result}>
      {todo.outcome ? <OutcomeLine outcome={todo.outcome} stats={stats} /> : null}
      {todo.detail?.length || todo.display?.length ? <StepSummaryBody todo={todo} /> : null}
      {processAnomaly ? (
        <View style={[styles.anomaly, { backgroundColor: warn.subtle }]}>
          <TriangleAlert size={14} color={warn.tint} strokeWidth={2} style={styles.outcomeIcon} />
          <Text style={[typo.bodySmall, styles.flexText, { color: warn.ink }]}>
            步骤结果已完成，但过程记录中仍有异常，请以平台执行事实为准。
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={[styles.collapsible, { borderColor: colors.border }]}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        style={styles.collapsibleHeader}
      >
        <Text
          style={[
            typo.bodySmall,
            styles.flexText,
            { color: colors.foreground, fontWeight: fontWeight.medium },
          ]}
        >
          {title}
        </Text>
        <ChevronRight
          size={16}
          color={colors.mutedForeground}
          style={open ? styles.rotated : undefined}
        />
      </Pressable>
      {open ? (
        <View style={[styles.collapsibleBody, { borderTopColor: colors.border }]}>{children}</View>
      ) : null}
    </View>
  );
}

export function BusinessStepDetailSheet({
  visible,
  todo,
  planClosed,
  onClose,
}: {
  visible: boolean;
  todo: TodoItem | null;
  planClosed?: boolean;
  onClose: () => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const hasResult = !!todo?.outcome || !!todo?.detail?.length || !!todo?.display?.length;

  return (
    <BottomSheet visible={visible} onClose={onClose} title="任务步骤" snap="half">
      {todo ? (
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
          <View style={styles.header}>
            <BusinessStepStatusIcon todo={todo} planClosed={planClosed} />
            <Text style={[typo.subtitle, styles.flexText, { color: colors.foreground }]}>
              {todo.content}
            </Text>
          </View>
          <Text style={[typo.caption, { color: colors.mutedForeground }]}>
            {todoStatusMeta(todo).label}
          </Text>
          {hasResult ? (
            <BusinessStepResultContent todo={todo} />
          ) : (
            <Text style={[typo.bodySmall, { color: colors.mutedForeground }]}>暂无结果</Text>
          )}
          {todo.evidenceRefs?.length ? (
            <CollapsibleSection title="依据">
              <EvidenceRefs refs={todo.evidenceRefs} />
            </CollapsibleSection>
          ) : null}
        </ScrollView>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  result: { gap: spacing.md },
  flexText: { flex: 1, minWidth: 0 },
  outcomeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  outcomeIcon: { marginTop: 3 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, alignItems: 'center' },
  neutralChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  anomaly: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  collapsible: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  collapsibleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  collapsibleBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rotated: { transform: [{ rotate: '90deg' }] },
  sheetScroll: { maxHeight: '100%' },
  sheetContent: { gap: spacing.sm, paddingBottom: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
