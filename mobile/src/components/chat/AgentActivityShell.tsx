import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { CheckCircle2, ChevronRight, CircleAlert, CircleX, Clock3, PauseCircle } from 'lucide-react-native';
import { useColors, spacing, radius, typography, type ThemeColors } from '../../theme';

export type AgentActivityState = 'running' | 'completed' | 'warning' | 'failed' | 'waiting' | 'cancelled';

const LABELS: Record<AgentActivityState, string> = {
  running: '运行中',
  completed: '已完成',
  warning: '有异常',
  failed: '失败',
  waiting: '等待中',
  cancelled: '已取消',
};

function StateIcon({ state, colors }: { state: AgentActivityState; colors: ThemeColors }) {
  if (state === 'running') return <ActivityIndicator size="small" color={colors.primary} />;
  if (state === 'completed') return <CheckCircle2 size={16} color={colors.success} />;
  if (state === 'warning') return <CircleAlert size={16} color={colors.warning} />;
  if (state === 'failed') return <CircleX size={16} color={colors.destructive} />;
  if (state === 'cancelled') return <PauseCircle size={16} color={colors.mutedForeground} />;
  return <Clock3 size={16} color={colors.warning} />;
}

export function AgentActivityShell({
  state,
  title,
  subtitle,
  meta,
  expanded,
  onToggle,
  children,
}: {
  state: AgentActivityState;
  title: string;
  subtitle?: string;
  meta?: string;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  return (
    <View style={styles.card}>
      <Pressable style={styles.header} onPress={onToggle}>
        <StateIcon state={state} colors={colors} />
        <View style={styles.titleArea}>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
            <Text style={styles.state}>{LABELS[state]}</Text>
          </View>
          {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
        <ChevronRight
          size={16}
          color={colors.mutedForeground}
          style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
        />
      </Pressable>
      {expanded && children ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      marginVertical: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.muted,
      overflow: 'hidden',
    },
    header: {
      minHeight: 46,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    titleArea: {
      flex: 1,
      minWidth: 0,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    title: {
      ...typography.bodySmall,
      flexShrink: 1,
      color: colors.foreground,
      fontWeight: '600',
    },
    state: {
      fontSize: 9,
      color: colors.mutedForeground,
    },
    subtitle: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    meta: {
      ...typography.caption,
      maxWidth: 90,
      color: colors.mutedForeground,
    },
    body: {
      padding: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
    },
  });
}
