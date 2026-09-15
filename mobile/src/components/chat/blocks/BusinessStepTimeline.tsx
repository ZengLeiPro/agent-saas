/**
 * 业务步骤时间线 —— 与 `web/src/components/BusinessStepFlow.tsx` 的 PlanTodoRow 同构：
 * 左侧竖线把各步串成一条线，节点是状态图标，右侧是步骤标题、墙钟耗时与序号。
 *
 * Web 用 `::before/::after` 伪元素画竖线；RN 没有伪元素，改为绝对定位的两段细线
 * （节点上方 / 下方），首尾两步各省掉一段——视觉结果一致。
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { Circle, CircleCheck, CircleX, Clock3, Loader2, TriangleAlert } from 'lucide-react-native';
import type { BusinessStepIcon, BusinessStepTodoTiming, TodoItem } from '@agent/shared';
import {
  formatActivityDuration,
  isEndedWithoutTerminal,
  resolveBusinessStepDurationMs,
  todoAccessibleStatus,
  todoStatusMeta,
} from '@agent/shared';
import { useColors, spacing, radius, fontWeight, useChatTypography } from '../../../theme';
import { useSpinStyle } from '../../ui';
import { resolveActivityToneTokens } from './tone';

const ICON_BY_KEY: Record<BusinessStepIcon, typeof Circle> = {
  progress: Loader2,
  clock: Clock3,
  alert: TriangleAlert,
  check: CircleCheck,
  x: CircleX,
  circle: Circle,
};

const NODE_SIZE = 20;
const ICON_SIZE = 16;
/** 竖线与节点圆心对齐：节点左边距 + 半径。 */
const LINE_LEFT = spacing.md + NODE_SIZE / 2;

export function BusinessStepStatusIcon({
  todo,
  planClosed,
  size = ICON_SIZE,
}: {
  todo: TodoItem;
  planClosed?: boolean;
  size?: number;
}) {
  const colors = useColors();
  const ended = isEndedWithoutTerminal(todo, planClosed);
  const meta = todoStatusMeta(todo);
  const tone = resolveActivityToneTokens(ended ? 'neutral' : meta.tone, colors);
  const Icon = ended ? Circle : ICON_BY_KEY[meta.icon];
  const spin = useSpinStyle(meta.spin && !ended);
  const glyph = <Icon size={size} color={tone.tint} strokeWidth={2} />;
  if (!meta.spin || ended) return glyph;
  return <Animated.View style={spin}>{glyph}</Animated.View>;
}

export function BusinessStepTimelineRow({
  todo,
  index,
  isFirst,
  isLast,
  planClosed,
  selected,
  timing,
  onPress,
}: {
  todo: TodoItem;
  /** 1-based 序号 */
  index: number;
  isFirst: boolean;
  isLast: boolean;
  planClosed?: boolean;
  selected?: boolean;
  timing?: BusinessStepTodoTiming;
  onPress?: () => void;
}) {
  const colors = useColors();
  const typo = useChatTypography();
  const isCurrent = !planClosed && todo.status === 'in_progress';
  const live = timing?.liveStartedAtMs !== undefined;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, timing?.liveStartedAtMs, timing?.timingMeasuredAtMs, timing?.durationMs]);
  const durationMs = resolveBusinessStepDurationMs(timing, live ? nowMs : Date.now());
  const durationLabel = formatActivityDuration(durationMs) ?? undefined;

  return (
    <View>
      {isFirst ? null : <View style={[styles.lineAbove, { backgroundColor: colors.border }]} />}
      {isLast ? null : <View style={[styles.lineBelow, { backgroundColor: colors.border }]} />}
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityState={{ selected: !!selected }}
        accessibilityLabel={[
          todo.content,
          todoAccessibleStatus(todo, planClosed),
          durationLabel,
          todo.outcome?.text,
        ]
          .filter(Boolean)
          .join('，')}
        style={[styles.row, selected ? { backgroundColor: colors.accent } : null]}
      >
        <View style={[styles.node, { backgroundColor: colors.card }]}>
          <BusinessStepStatusIcon todo={todo} planClosed={planClosed} />
        </View>
        <Text
          numberOfLines={2}
          style={[
            typo.bodySmall,
            styles.title,
            {
              color: todo.status === 'pending' ? colors.mutedForeground : colors.foreground,
              fontWeight: isCurrent ? fontWeight.semibold : fontWeight.medium,
            },
          ]}
        >
          {todo.content}
        </Text>
        {durationLabel ? (
          <Text
            testID="business-step-duration"
            style={[
              typo.meta,
              styles.duration,
              { color: colors.mutedForeground, opacity: 0.6, fontVariant: ['tabular-nums'] },
            ]}
          >
            {durationLabel}
          </Text>
        ) : null}
        <Text
          style={[
            typo.meta,
            styles.index,
            { color: colors.mutedForeground, opacity: 0.6, fontVariant: ['tabular-nums'] },
          ]}
        >
          {String(index).padStart(2, '0')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
  },
  node: {
    width: NODE_SIZE,
    height: NODE_SIZE,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
  },
  lineAbove: {
    position: 'absolute',
    left: LINE_LEFT,
    top: 0,
    width: StyleSheet.hairlineWidth,
    height: spacing.sm,
  },
  lineBelow: {
    position: 'absolute',
    left: LINE_LEFT,
    top: spacing.sm + NODE_SIZE,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, minWidth: 0 },
  duration: { flexShrink: 0, paddingTop: 2 },
  index: { width: 20, textAlign: 'right', paddingTop: 2 },
});
