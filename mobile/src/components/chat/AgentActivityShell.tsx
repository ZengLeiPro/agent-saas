/**
 * 过程痕迹的排版型外壳 —— 与 `web/src/components/AgentActivityShell.tsx` 同构：
 * 折叠态 = 一行低噪文字（状态 icon + 摘要 + meta + chevron），无边框无背景；
 * 展开区 = 缩进 + 极淡左竖线。状态文案只进无障碍朗读，不在可视行重复「运行中」。
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { CheckCircle2, ChevronRight, CircleAlert, CircleX, Clock3, PauseCircle } from 'lucide-react-native';
import { useColors, spacing, typography, fontScale, type ThemeColors } from '../../theme';
import { resolveActivityToneTokens } from './blocks/tone';

export type AgentActivityState = 'running' | 'completed' | 'warning' | 'failed' | 'waiting' | 'cancelled';

const LABELS: Record<AgentActivityState, string> = {
  running: '运行中',
  completed: '已完成',
  warning: '有异常',
  failed: '失败',
  waiting: '等待中',
  cancelled: '已取消',
};

function stateTone(state: AgentActivityState): Parameters<typeof resolveActivityToneTokens>[0] {
  if (state === 'running') return 'active';
  if (state === 'completed') return 'success';
  if (state === 'warning' || state === 'waiting') return 'warning';
  if (state === 'failed') return 'danger';
  return 'neutral';
}

function StateIcon({ state, colors }: { state: AgentActivityState; colors: ThemeColors }) {
  const tint = resolveActivityToneTokens(stateTone(state), colors).tint;
  if (state === 'running') return <ActivityIndicator size="small" color={tint} />;
  if (state === 'completed') return <CheckCircle2 size={14} color={tint} />;
  if (state === 'warning') return <CircleAlert size={14} color={tint} />;
  if (state === 'failed') return <CircleX size={14} color={tint} />;
  if (state === 'cancelled') return <PauseCircle size={14} color={tint} />;
  return <Clock3 size={14} color={tint} />;
}

export function AgentActivityShell({
  state,
  title,
  subtitle,
  meta,
  expanded,
  disabled = false,
  onToggle,
  children,
}: {
  state: AgentActivityState;
  title: string;
  subtitle?: string;
  meta?: string;
  expanded: boolean;
  /** 非 debug 时不可展开（与 Web 一致）。 */
  disabled?: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const header = (
    <>
      <StateIcon state={state} colors={colors} />
      <View style={styles.titleArea}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
          {subtitle ? <Text style={styles.subtitle}>{` · ${subtitle}`}</Text> : null}
        </Text>
      </View>
      {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
      {!disabled ? (
        <ChevronRight
          size={14}
          color={colors.mutedForeground}
          style={{ opacity: 0.6, transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
        />
      ) : null}
    </>
  );

  return (
    <View>
      {disabled ? (
        <View
          style={styles.header}
          accessibilityRole="summary"
          accessibilityLabel={`${title}${subtitle ? `，${subtitle}` : ''}${meta ? `，${meta}` : ''}，${LABELS[state]}`}
          accessibilityLiveRegion={state === 'failed' || state === 'warning' ? 'assertive' : 'polite'}
        >
          {header}
        </View>
      ) : (
        <Pressable
          style={styles.header}
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={`${title}${subtitle ? `，${subtitle}` : ''}${meta ? `，${meta}` : ''}，${LABELS[state]}`}
          accessibilityState={{ expanded }}
          accessibilityLiveRegion={state === 'failed' || state === 'warning' ? 'assertive' : 'polite'}
        >
          {header}
        </Pressable>
      )}
      {expanded && children ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    header: {
      minHeight: 28,
      paddingVertical: spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    titleArea: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
    },
    subtitle: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
      opacity: 0.7,
    },
    meta: {
      ...fontScale.xs2,
      flexShrink: 0,
      color: colors.mutedForeground,
      opacity: 0.7,
      fontVariant: ['tabular-nums'],
    },
    body: {
      marginLeft: 7,
      marginTop: spacing.sm,
      paddingVertical: spacing.xs,
      paddingLeft: spacing.md + spacing.xs,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.border,
      gap: spacing.xs,
    },
  });
}
