/** A compact overview of the plan; step details use the same safe-area bottom sheet as the timeline. */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Keyboard } from 'react-native';
import { ListChecks } from 'lucide-react-native';
import type { BusinessStepEventItem } from '@agent/shared';
import { businessStepOverallStatus, todoItemKey } from '@agent/shared';
import { useColors, spacing, radius, fontWeight, useChatTypography } from '../../../theme';
import { Badge } from '../../ui';
import { BusinessStepDetailSheet } from './BusinessStepDetailSheet';
import { BusinessStepTimelineRow } from './BusinessStepTimeline';
import { toneBadgeVariant } from './tone';

export function BusinessStepFlow({ event }: { event: BusinessStepEventItem }) {
  const colors = useColors();
  const typo = useChatTypography();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const todos = useMemo(() => event.kind === 'plan' ? event.todos ?? [] : [], [event]);
  const overall = useMemo(() => businessStepOverallStatus(todos, event.isClosed), [todos, event.isClosed]);
  const selectedTodo = useMemo(() => todos.find((todo) => todoItemKey(todo) === selectedKey) ?? null, [todos, selectedKey]);
  if (event.kind !== 'plan') return null;
  return <View accessibilityRole="summary"
    accessibilityLabel={`业务步骤，${overall.label}，共 ${todos.length} 步，已完成 ${overall.completed} 步`}
    style={[styles.card, { borderColor: colors.border, backgroundColor: colors.card }]}>
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Text style={[typo.bodySmall, styles.flexText, { color: colors.foreground, fontWeight: fontWeight.semibold }]}>任务步骤</Text>
      <Text style={[typo.meta, { color: colors.mutedForeground }]}>{`${overall.completed}/${todos.length}`}</Text>
      <Badge size="sm" variant={toneBadgeVariant(overall.tone)} label={overall.label} />
    </View>
    <View style={styles.list}>{todos.map((todo, index) => {
      const key = todoItemKey(todo);
      return <BusinessStepTimelineRow key={key || `${index}-${todo.content}`} todo={todo} index={index + 1}
        isFirst={index === 0} isLast={index === todos.length - 1} planClosed={event.isClosed}
        selected={key === selectedKey} onPress={() => { Keyboard.dismiss(); setSelectedKey(key); }} />;
    })}</View>
    <BusinessStepDetailSheet visible={!!selectedTodo} todo={selectedTodo} todos={todos} planClosed={event.isClosed}
      onSelectTodo={(todo) => setSelectedKey(todoItemKey(todo))} onClose={() => setSelectedKey(null)} />
  </View>;
}
export function BusinessStepPlanUpdate({ event }: { event: BusinessStepEventItem }) {
  const colors = useColors();
  const typo = useChatTypography();
  if (event.kind !== 'update') return null;
  return <View accessibilityRole="summary" style={[styles.update, { backgroundColor: colors.muted }]}>
    <ListChecks size={14} color={colors.mutedForeground} strokeWidth={2} />
    <Text style={[typo.caption, { color: colors.mutedForeground }]}>{`计划已调整 · 共 ${event.stepCount ?? '-'} 步`}</Text>
  </View>;
}
const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius['2xl'], padding: spacing.sm, gap: spacing.xs },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  flexText: { flex: 1, minWidth: 0 }, list: { gap: 2 },
  update: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.lg,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
});
