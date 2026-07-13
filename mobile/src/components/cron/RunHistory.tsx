import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { CircleCheck, CircleX, CircleMinus, Circle, type LucideIcon } from 'lucide-react-native';
import type { CronRunLogEntry } from '@agent/shared';
import { useColors, spacing, typography, radius, type ThemeColors } from '../../theme';

interface RunHistoryProps {
  entries: CronRunLogEntry[];
  loading: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function getStatusIcon(status: string, colors: ThemeColors): { Icon: LucideIcon; color: string } {
  switch (status) {
    case 'ok': return { Icon: CircleCheck, color: colors.statusIcon.success };
    case 'error': return { Icon: CircleX, color: colors.destructive };
    case 'skipped': return { Icon: CircleMinus, color: colors.statusIcon.warning };
    default: return { Icon: Circle, color: colors.mutedForeground };
  }
}

export function RunHistory({ entries, loading }: RunHistoryProps) {
  const colors = useColors();

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
    },
    content: {
      padding: spacing.md,
    },
    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingTop: 60,
    },
    emptyText: {
      ...typography.body,
      color: colors.mutedForeground,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowContent: {
      flex: 1,
    },
    rowHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    time: {
      ...typography.caption,
      color: colors.foreground,
    },
    duration: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    errorText: {
      ...typography.caption,
      color: colors.destructive,
      marginTop: 2,
    },
  }), [colors]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (entries.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>暂无运行记录</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {entries.map((entry) => {
        const icon = getStatusIcon(entry.status, colors);
        return (
          <View key={entry.runId} style={styles.row}>
            <icon.Icon size={18} color={icon.color} strokeWidth={2} />
            <View style={styles.rowContent}>
              <View style={styles.rowHeader}>
                <Text style={styles.time}>
                  {new Date(entry.startedAtMs).toLocaleString()}
                </Text>
                {entry.durationMs != null && (
                  <Text style={styles.duration}>{formatDuration(entry.durationMs)}</Text>
                )}
              </View>
              {entry.status === 'error' && entry.error && (
                <Text style={styles.errorText} numberOfLines={2}>
                  {entry.error}
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
