/** Business steps stay compact in chat; the bottom sheet owns the full result/process/evidence. */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Keyboard } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import type { BusinessStepEventItem, BusinessStepSection, RawPresentationGate, RenderItem } from '@agent/shared';
import { businessStepResultPlaceholder, selectBusinessStepPresentation, todoStatusMeta, visibleOutcomeStats } from '@agent/shared';
import { useColors, spacing, radius, fontWeight, useChatTypography } from '../../../theme';
import { Badge } from '../../ui';
import { CanonicalPresentationBody } from './PresentationBlock';
import { BusinessStepFlow, BusinessStepPlanUpdate } from './BusinessStepFlow';
import { BusinessStepDetailSheet, OutcomeLine } from './BusinessStepDetailSheet';
import { BusinessStepStatusIcon } from './BusinessStepTimeline';
import { partitionBusinessStepItems } from './businessStepDetails';
import { toneBadgeVariant } from './tone';

export type BusinessStepRenderItem = (item: RenderItem) => React.ReactNode;

export function BusinessStepSectionView({ section, renderItem }: {
  section: BusinessStepSection; renderItem?: BusinessStepRenderItem;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const todo = section.terminal?.todo ?? section.start.todo;
  const meta = todo ? todoStatusMeta(todo) : null;
  const detail = useMemo(() => partitionBusinessStepItems(section.items, section.systemActionIds),
    [section.items, section.systemActionIds]);
  const stats = useMemo(() => visibleOutcomeStats(todo?.outcome?.stat, todo?.detail), [todo?.outcome?.stat, todo?.detail]);
  // Never hide an approval/question or an external-system write behind a detail drawer.
  // Malformed legacy sections without a selectable todo retain their original visible content.
  const inlineItems = todo ? detail.inline : section.items;
  return <View style={[styles.section, { borderColor: detailsOpen ? colors.borderStrong : colors.border, backgroundColor: colors.card }]}>
    <Pressable disabled={!todo} onPress={() => { Keyboard.dismiss(); setDetailsOpen(true); }}
      accessibilityRole="button" accessibilityState={{ expanded: detailsOpen, disabled: !todo }}
      accessibilityLabel={`查看步骤详情：${todo?.content ?? '业务步骤'}${meta ? `，${meta.label}` : ''}`}
      accessibilityHint="从底部打开完整结果、卡片、表格和执行过程"
      style={({ pressed }) => [styles.stepButton, pressed && { backgroundColor: colors.muted }]}>
      <View style={styles.sectionHeader}>
        {todo ? <BusinessStepStatusIcon todo={todo} /> : null}
        <Text numberOfLines={2} style={[typo.bodySmall, styles.flexText,
          { color: colors.foreground, fontWeight: fontWeight.semibold }]}>{todo?.content ?? '业务步骤'}</Text>
        {meta ? <Badge size="sm" variant={toneBadgeVariant(meta.tone)} label={meta.label} /> : null}
        {todo ? <ChevronRight size={16} color={colors.mutedForeground} /> : null}
      </View>
      {todo?.outcome ? <OutcomeLine outcome={todo.outcome} stats={stats} compact /> : todo ?
        <Text style={[typo.caption, { color: colors.mutedForeground }]}>{businessStepResultPlaceholder(todo)}</Text> : null}
      {section.resumePending ? <Text style={[typo.caption, { color: colors.mutedForeground }]}>等待恢复执行</Text> : null}
      {section.processAnomaly ? <View style={styles.flag}><Badge size="sm" variant={toneBadgeVariant('warning')} label="过程存在异常" /></View> : null}
      {todo ? <Text style={[typo.caption, { color: colors.mutedForeground }]}>
        {detail.process.length ? `查看详情 · ${detail.process.length} 条过程记录` : '查看完整详情'}
      </Text> : null}
    </Pressable>
    {renderItem && inlineItems.length > 0 ? <View style={[styles.pinned, { borderTopColor: colors.border }]}>
      {inlineItems.map((item) => <View key={item.id}>{renderItem(item)}</View>)}
    </View> : null}
    <BusinessStepDetailSheet visible={detailsOpen && !!todo} todo={todo ?? null} items={section.items}
      renderItem={renderItem} processAnomaly={section.processAnomaly} onClose={() => setDetailsOpen(false)} />
  </View>;
}

/** Isolated events keep their canonical presenter and RawPresentationGate; no raw-data shortcut is added. */
export function BusinessStepCard({ event, gate }: { event: BusinessStepEventItem; gate?: RawPresentationGate }) {
  const colors = useColors();
  const typo = useChatTypography();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const presentation = useMemo(() => selectBusinessStepPresentation(event, gate), [event, gate]);
  if (event.kind === 'plan') return <BusinessStepFlow event={event} />;
  if (event.kind === 'update') return <BusinessStepPlanUpdate event={event} />;
  return <View style={[styles.section, { borderColor: colors.border, backgroundColor: colors.card }]}>
    <Pressable disabled={!event.todo} onPress={() => { Keyboard.dismiss(); setDetailsOpen(true); }}
      accessibilityRole={event.todo ? 'button' : 'summary'} accessibilityState={{ expanded: detailsOpen }}
      accessibilityLabel={[presentation.title, presentation.statusLabel, presentation.summary].filter(Boolean).join('，')}
      style={({ pressed }) => [styles.stepButton, pressed && { backgroundColor: colors.muted }]}>
      <View style={styles.sectionHeader}>
        <Text style={[typo.bodySmall, styles.flexText, { color: colors.foreground, fontWeight: fontWeight.semibold }]}>{presentation.title}</Text>
        <Badge size="sm" variant={toneBadgeVariant(presentation.tone === 'danger' ? 'danger' : 'neutral')} label={presentation.statusLabel} />
        {event.todo ? <ChevronRight size={16} color={colors.mutedForeground} /> : null}
      </View>
      {event.todo ? <Text numberOfLines={3} style={[typo.bodySmall, { color: colors.mutedForeground }]}>{presentation.summary || '查看完整详情'}</Text>
        : <CanonicalPresentationBody presentation={presentation} />}
    </Pressable>
    <BusinessStepDetailSheet visible={detailsOpen && !!event.todo} todo={event.todo ?? null} onClose={() => setDetailsOpen(false)} />
  </View>;
}
const styles = StyleSheet.create({
  section: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius['2xl'], overflow: 'hidden' },
  stepButton: { padding: spacing.md, gap: spacing.sm, minHeight: 48 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flexText: { flex: 1, minWidth: 0 }, flag: { alignSelf: 'flex-start' },
  pinned: { borderTopWidth: StyleSheet.hairlineWidth, padding: spacing.sm, gap: spacing.sm },
});
