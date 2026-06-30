import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

function getStatusIcon(status: string, colors: ThemeColors): { name: keyof typeof Ionicons.glyphMap; color: string } {
  switch (status) {
    case 'ok': return { name: 'checkmark-circle', color: colors.statusIcon.success };
    case 'error': return { name: 'close-circle', color: colors.destructive };
    case 'skipped': return { name: 'remove-circle-outline', color: colors.statusIcon.warning };
    default: return { name: 'ellipse-outline', color: colors.mutedForeground };
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
            <Ionicons name={icon.name} size={18} color={icon.color} />
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
