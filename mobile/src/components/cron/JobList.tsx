import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Switch,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Ionicons } from '@expo/vector-icons';
import type { CronJob } from '@agent/shared';
import { useColors, spacing, typography, radius, type ThemeColors } from '../../theme';
import { hapticLight } from '../../lib/haptics';

interface JobListProps {
  jobs: CronJob[];
  loading: boolean;
  listRef?: React.RefObject<FlashListRef<CronJob> | null>;
  onRefresh: () => Promise<void>;
  onSelect: (job: CronJob) => void;
  onToggle: (job: CronJob) => Promise<void>;
  contentPaddingTop?: number;
  contentPaddingBottom?: number;
}

function formatSchedule(job: CronJob): string {
  const s = job.schedule;
  if (s.kind === 'every') {
    const totalSec = Math.round(s.everyMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    const parts: string[] = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (sec) parts.push(`${sec}s`);
    return `每 ${parts.join(' ')}`;
  }
  if (s.kind === 'cron') return s.expr;
  if (s.kind === 'at') return `定时 ${new Date(s.atMs).toLocaleString()}`;
  return '未知';
}

function getStatusColor(job: CronJob, colors: ThemeColors): string {
  if (!job.enabled) return colors.mutedForeground;
  const state = job.state;
  if (state.runningAtMs) return colors.statusIcon.info;
  if (state.lastStatus === 'ok') return colors.statusIcon.success;
  if (state.lastStatus === 'error') return colors.destructive;
  return colors.mutedForeground;
}

function getModelLabel(job: CronJob): string | undefined {
  if (job.payload.kind === 'agentTurn' && job.payload.model) {
    const m = job.payload.model;
    const slash = m.lastIndexOf('/');
    return slash >= 0 ? m.slice(slash + 1) : m;
  }
  return undefined;
}

function JobCard({
  job,
  onSelect,
  onToggle,
}: {
  job: CronJob;
  onSelect: (job: CronJob) => void;
  onToggle: (job: CronJob) => Promise<void>;
}) {
  const colors = useColors();
  const statusColor = getStatusColor(job, colors);

  const styles = useMemo(() => StyleSheet.create({
    card: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      padding: spacing.md,
      marginBottom: spacing.sm,
      flexDirection: 'row',
      alignItems: 'stretch',
    },
    cardContent: {
      flex: 1,
    },
    cardContentDisabled: {
      opacity: 0.5,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.xs,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    jobName: {
      ...typography.subtitle,
      color: colors.foreground,
      flex: 1,
    },
    textDisabled: {
      color: colors.mutedForeground,
    },
    toggleColumn: {
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: spacing.sm,
    },
    cardMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 2,
      paddingLeft: 18,
    },
    metaText: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    metaSep: {
      ...typography.caption,
      color: colors.mutedForeground,
      marginHorizontal: 2,
    },
  }), [colors]);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => { hapticLight(); onSelect(job); }}
    >
      <View style={styles.card}>
        <View style={[styles.cardContent, !job.enabled && styles.cardContentDisabled]}>
          <View style={styles.cardHeader}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.jobName, !job.enabled && styles.textDisabled]} numberOfLines={1}>
              {job.name}
            </Text>
          </View>
          <View style={styles.cardMeta}>
            <Ionicons name="time-outline" size={14} color={colors.mutedForeground} />
            <Text style={styles.metaText}>{formatSchedule(job)}</Text>
            {getModelLabel(job) && (
              <>
                <Text style={styles.metaSep}>·</Text>
                <Text style={styles.metaText} numberOfLines={1}>{getModelLabel(job)}</Text>
              </>
            )}
          </View>
          {job.state.lastRunAtMs ? (
            <View style={styles.cardMeta}>
              <Ionicons name="checkmark-done-outline" size={14} color={colors.mutedForeground} />
              <Text style={styles.metaText}>
                上次: {new Date(job.state.lastRunAtMs).toLocaleString()}
              </Text>
            </View>
          ) : null}
          {job.state.nextRunAtMs && (
            <View style={styles.cardMeta}>
              <Ionicons name="arrow-forward-outline" size={14} color={colors.mutedForeground} />
              <Text style={styles.metaText}>
                下次: {new Date(job.state.nextRunAtMs).toLocaleString()}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.toggleColumn}>
          <Switch
            value={job.enabled}
            onValueChange={() => { hapticLight(); void onToggle(job); }}
            trackColor={{ false: colors.muted, true: colors.success }}
            thumbColor={colors.card}
            ios_backgroundColor={colors.muted}
          />
        </View>
      </View>
    </TouchableOpacity>
  );
}

export function JobList({ jobs, loading, listRef, onRefresh, onSelect, onToggle, contentPaddingTop, contentPaddingBottom }: JobListProps) {
  const colors = useColors();

  const styles = useMemo(() => StyleSheet.create({
    listContent: {
      padding: spacing.md,
    },
    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingTop: 100,
    },
    emptyText: {
      ...typography.body,
      color: colors.mutedForeground,
    },
  }), [colors]);

  if (loading && jobs.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <FlashList
      ref={listRef}
      data={jobs}
      drawDistance={250}
      overrideProps={{ initialDrawBatchSize: 10 }}
      keyExtractor={item => item.id}
      renderItem={({ item }) => (
        <JobCard
          job={item}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      )}
      contentContainerStyle={{
        ...styles.listContent,
        ...(contentPaddingTop != null && { paddingTop: contentPaddingTop }),
        ...(contentPaddingBottom != null && { paddingBottom: contentPaddingBottom }),
      }}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={colors.primary} />
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyText}>暂无定时任务</Text>
        </View>
      }
    />
  );
}
