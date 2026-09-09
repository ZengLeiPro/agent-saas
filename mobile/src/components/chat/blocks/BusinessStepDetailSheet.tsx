/** Web-aligned business detail: result and deliverables first, then collapsible process/evidence. */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { ChevronRight, CircleX, TriangleAlert } from 'lucide-react-native';
import type { OutcomeStat, RenderItem, TodoItem, TodoOutcome } from '@agent/shared';
import { businessStepResultPlaceholder, migrateLegacySectionVerdicts, outcomeToneMeta,
  statVerdict, todoItemKey, todoStatusMeta, visibleOutcomeStats } from '@agent/shared';
import { useColors, spacing, radius, fontWeight, useChatTypography } from '../../../theme';
import { Badge, BottomSheet } from '../../ui';
import { DetailLines } from './DetailLines';
import { PresentationBlocks } from './PresentationBlockViews';
import { RecordsBlockView } from './RecordsBlockView';
import { EvidenceRefs } from './PresentationBlock';
import { BusinessStepStatusIcon } from './BusinessStepTimeline';
import { resolveActivityToneTokens, toneBadgeVariant } from './tone';
import { partitionBusinessStepItems } from './businessStepDetails';

function StatChip({ stat }: { stat: OutcomeStat }) {
  const colors = useColors();
  const typo = useChatTypography();
  const verdict = statVerdict(stat);
  if (verdict) return <Badge size="sm" variant={toneBadgeVariant(verdict === 'pass' ? 'success' : 'danger')}
    label={`${stat.label} ${stat.value}`} />;
  return <Text style={[typo.meta, styles.neutralChip, { color: colors.mutedForeground, borderColor: colors.border }]}>
    {`${stat.label} `}<Text style={{ color: colors.foreground, fontWeight: fontWeight.medium }}>{stat.value}</Text>
  </Text>;
}

export function OutcomeLine({ outcome, stats, compact = false }: {
  outcome: TodoOutcome; stats: readonly OutcomeStat[]; compact?: boolean;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const meta = outcomeToneMeta(outcome);
  const tone = resolveActivityToneTokens(meta.tone, colors);
  const Icon = meta.icon === 'x' ? CircleX : meta.icon === 'alert' ? TriangleAlert : null;
  return <View style={styles.stack}>
    <View style={styles.outcomeRow}>
      {Icon ? <Icon size={14} color={tone.tint} strokeWidth={2} style={styles.outcomeIcon} /> : null}
      <Text numberOfLines={compact ? 3 : undefined}
        style={[typo.bodySmall, styles.flexText, { color: meta.icon ? tone.ink : colors.foreground }]}>{outcome.text}</Text>
    </View>
    {stats.length ? <View style={styles.chips}>{stats.map((stat) =>
      <StatChip key={`${stat.label}-${stat.value}`} stat={stat} />)}</View> : null}
  </View>;
}

function StepSummaryBody({ todo }: { todo: TodoItem }) {
  const parts = useMemo(() => migrateLegacySectionVerdicts(todo.detail), [todo.detail]);
  return <View style={styles.stack}>
    {parts.map((part, index) => part.kind === 'detail'
      ? <DetailLines key={index} lines={part.lines} /> : <RecordsBlockView key={index} block={part.block} />)}
    {todo.display?.length ? <PresentationBlocks blocks={todo.display} /> : null}
  </View>;
}

export function BusinessStepResultContent({ todo, processAnomaly }: { todo: TodoItem; processAnomaly?: boolean }) {
  const colors = useColors();
  const typo = useChatTypography();
  const warn = resolveActivityToneTokens('warning', colors);
  const stats = useMemo(() => visibleOutcomeStats(todo.outcome?.stat, todo.detail), [todo.outcome?.stat, todo.detail]);
  return <View style={styles.result}>
    {todo.outcome ? <OutcomeLine outcome={todo.outcome} stats={stats} /> : null}
    {todo.detail?.length || todo.display?.length ? <StepSummaryBody todo={todo} /> : null}
    {processAnomaly ? <View style={[styles.anomaly, { backgroundColor: warn.subtle }]}>
      <TriangleAlert size={14} color={warn.tint} strokeWidth={2} style={styles.outcomeIcon} />
      <Text style={[typo.bodySmall, styles.flexText, { color: warn.ink }]}>步骤结果已完成，但过程记录中仍有异常，请以平台执行事实为准。</Text>
    </View> : null}
  </View>;
}

function CollapsibleSection({ title, defaultOpen = false, children }: {
  title: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const [open, setOpen] = useState(defaultOpen);
  return <View style={[styles.collapsible, { borderColor: colors.border }]}>
    <Pressable onPress={() => setOpen((value) => !value)} accessibilityRole="button"
      accessibilityState={{ expanded: open }} accessibilityLabel={title} style={styles.collapsibleHeader}>
      <Text style={[typo.bodySmall, styles.flexText, { color: colors.foreground, fontWeight: fontWeight.medium }]}>{title}</Text>
      <ChevronRight size={16} color={colors.mutedForeground} style={open ? styles.rotated : undefined} />
    </Pressable>
    {open ? <View style={[styles.collapsibleBody, { borderTopColor: colors.border }]}>{children}</View> : null}
  </View>;
}
const EMPTY_ITEMS: readonly RenderItem[] = [];
const EMPTY_TODOS: readonly TodoItem[] = [];

export function BusinessStepDetailSheet({ visible, todo, planClosed, onClose, items = EMPTY_ITEMS,
  renderItem, processAnomaly, todos = EMPTY_TODOS, onSelectTodo }: {
  visible: boolean;
  todo: TodoItem | null;
  planClosed?: boolean;
  onClose: () => void;
  items?: readonly RenderItem[];
  renderItem?: (item: RenderItem) => React.ReactNode;
  processAnomaly?: boolean;
  todos?: readonly TodoItem[];
  onSelectTodo?: (todo: TodoItem) => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const detail = useMemo(() => partitionBusinessStepItems(items), [items]);
  const hasResult = !!todo?.outcome || !!todo?.detail?.length || !!todo?.display?.length || !!processAnomaly;
  const status = todo ? todoStatusMeta(todo, planClosed) : null;
  const key = todo ? todoItemKey(todo) : '';
  return <BottomSheet visible={visible} onClose={onClose} title="任务步骤" snap="full" testID="business-step-detail-sheet">
    {todo ? <View style={styles.sheetBody}>
      {todos.length > 1 && onSelectTodo ? <ScrollView horizontal showsHorizontalScrollIndicator={false}
        style={[styles.tabs, { borderBottomColor: colors.border }]} contentContainerStyle={styles.tabContent}
        accessibilityRole="tablist" accessibilityLabel="任务步骤">
        {todos.map((step, index) => {
          const selected = todoItemKey(step) === key;
          return <Pressable key={todoItemKey(step)} onPress={() => onSelectTodo(step)} accessibilityRole="tab"
            accessibilityState={{ selected }} accessibilityLabel={`第 ${index + 1} 步：${step.content}`}
            style={[styles.tab, { backgroundColor: selected ? colors.muted : colors.card, borderColor: selected ? colors.borderStrong : colors.border }]}>
            <BusinessStepStatusIcon todo={step} planClosed={planClosed} />
            <Text style={[typo.bodySmall, { color: selected ? colors.foreground : colors.mutedForeground }]}>{String(index + 1).padStart(2, '0')}</Text>
          </Pressable>;
        })}
      </ScrollView> : null}
      <ScrollView key={key} style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}
        contentInsetAdjustmentBehavior="never" keyboardShouldPersistTaps="handled" nestedScrollEnabled directionalLockEnabled>
        <View style={styles.header}>
          <BusinessStepStatusIcon todo={todo} planClosed={planClosed} />
          <Text accessibilityRole="header" style={[typo.subtitle, styles.flexText, { color: colors.foreground }]}>{todo.content}</Text>
        </View>
        {status ? <View style={styles.status}><Badge size="sm" variant={toneBadgeVariant(status.tone)} label={status.label} /></View> : null}
        <View style={styles.result} accessibilityLabel="步骤结果">
          <Text style={[typo.caption, styles.sectionTitle, { color: colors.mutedForeground }]}>结果</Text>
          {hasResult ? <BusinessStepResultContent todo={todo} processAnomaly={processAnomaly} />
            : <Text style={[typo.bodySmall, { color: colors.mutedForeground }]}>{businessStepResultPlaceholder(todo, planClosed)}</Text>}
        </View>
        {renderItem && detail.deliverables.length ? <View style={styles.result} accessibilityLabel="交付物">
          <Text style={[typo.caption, styles.sectionTitle, { color: colors.mutedForeground }]}>交付物</Text>
          {detail.deliverables.map((item) => <View key={item.id}>{renderItem(item)}</View>)}
        </View> : null}
        {renderItem && detail.process.length ? <CollapsibleSection key={`${key}:${todo.status}:process`}
          title={`过程 · ${detail.process.length} 项`} defaultOpen={todo.status === 'in_progress'}>
          <View style={styles.stack}>{detail.process.map((item) => <View key={item.id}>{renderItem(item)}</View>)}</View>
        </CollapsibleSection> : null}
        {todo.evidenceRefs?.length ? <CollapsibleSection key={`${key}:evidence`} title="依据">
          <EvidenceRefs refs={todo.evidenceRefs} />
        </CollapsibleSection> : null}
      </ScrollView>
    </View> : null}
  </BottomSheet>;
}
const styles = StyleSheet.create({
  stack: { gap: spacing.sm }, result: { gap: spacing.md }, flexText: { flex: 1, minWidth: 0 },
  outcomeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }, outcomeIcon: { marginTop: 3 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, alignItems: 'center' },
  neutralChip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: spacing.xs,
    paddingVertical: 1, overflow: 'hidden' },
  anomaly: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, borderRadius: radius.lg,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  collapsible: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, overflow: 'hidden' },
  collapsibleHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 48,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
  collapsibleBody: { borderTopWidth: StyleSheet.hairlineWidth, padding: spacing.md },
  rotated: { transform: [{ rotate: '90deg' }] },
  sheetBody: { flex: 1, minHeight: 0 }, sheetScroll: { flex: 1, minHeight: 0 },
  sheetContent: { gap: spacing.lg, padding: spacing.md, paddingBottom: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }, status: { alignSelf: 'flex-start' },
  sectionTitle: { fontWeight: fontWeight.semibold },
  tabs: { flexGrow: 0, flexShrink: 0, borderBottomWidth: StyleSheet.hairlineWidth },
  tabContent: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, gap: spacing.sm },
  tab: { minHeight: 44, minWidth: 60, paddingHorizontal: spacing.sm, borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
});
