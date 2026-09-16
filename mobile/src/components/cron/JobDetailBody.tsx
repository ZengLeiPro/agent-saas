/**
 * Cron job detail body — shared by `/cron/[jobId]` stack and md+ master-detail pane.
 */
import React, { useCallback, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Pause, Play, SquarePen } from 'lucide-react-native';
import { isDebugModeAvailable } from '@agent/shared';
import { useCronJobs, useRunHistory } from '../../hooks/useCronJobs';
import { CronJobForm } from './CronJobForm';
import { RunHistory } from './RunHistory';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { showActionMenu } from '../../lib/prompt';
import { useAuth } from '../../contexts/AuthContext';
import { useColors, spacing, fontScale, fontWeight } from '../../theme';
import { ICON_SIZE, ICON_STROKE, EntityIcons } from '../../lib/icons';

const SKELETON_ROWS = 4;
const SKELETON_ROW_HEIGHT = 56;

export type JobDetailBodyProps = {
  jobId: string;
  /** Called after successful delete (stack: router.back; pane: clear selection). */
  onDeleted?: () => void;
  /** Called when user taps edit. */
  onEdit?: (jobId: string, jobJson: string) => void;
  /** Pane chrome: show title + edit row inside the body. Stack routes keep Stack.Screen. */
  showInlineHeader?: boolean;
};

export function JobDetailBody({
  jobId,
  onDeleted,
  onEdit,
  showInlineHeader = false,
}: JobDetailBodyProps) {
  const colors = useColors();
  const { user } = useAuth();
  const { jobs, loading, runJob, toggleJob, deleteJob } = useCronJobs();
  const { entries, loading: historyLoading, error: historyError, reload } = useRunHistory(jobId);

  const job = useMemo(() => jobs.find((j) => j.id === jobId), [jobs, jobId]);
  const debugMode =
    user?.debugMode === true && isDebugModeAvailable(user.tenantId, user.tenantFeatures);

  const handleRun = useCallback(() => {
    if (!job) return;
    showActionMenu({
      title: '立即运行',
      message: `「${job.name}」会立刻真跑一轮，确认继续？`,
      actions: [
        {
          label: '立即运行一次',
          icon: Play,
          onPress: () => {
            void runJob(job.id).then(reload);
          },
        },
      ],
    });
  }, [job, runJob, reload]);

  const handleToggle = useCallback(() => {
    if (job) void toggleJob(job);
  }, [job, toggleJob]);

  const handleEdit = useCallback(() => {
    if (!job) return;
    onEdit?.(job.id, JSON.stringify(job));
  }, [job, onEdit]);

  const handleDelete = useCallback(() => {
    if (!job) return;
    showActionMenu({
      title: '删除任务',
      message: `「${job.name}」及其运行历史将被删除，且不可恢复。`,
      actions: [
        {
          label: '删除任务',
          destructive: true,
          onPress: () => {
            void deleteJob(job.id).then(() => onDeleted?.());
          },
        },
      ],
    });
  }, [job, deleteJob, onDeleted]);

  if (!job) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="cron-detail-body">
        {loading ? (
          <View style={styles.skeletonWrap} testID="cron-detail-skeleton">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <Skeleton key={index} height={SKELETON_ROW_HEIGHT} />
            ))}
          </View>
        ) : (
          <EmptyState
            icon={EntityIcons.cron}
            title="任务不存在"
            description="它可能已被删除，或不在你可见的范围内。"
            testID="cron-detail-missing"
          />
        )}
      </View>
    );
  }

  const actionBar = (
    <View style={styles.actions}>
      <Button
        label="立即运行"
        icon={Play}
        variant="primary"
        onPress={handleRun}
        style={styles.actionButton}
        testID="cron-detail-run"
      />
      <Button
        label={job.enabled ? '停用' : '启用'}
        icon={job.enabled ? Pause : Play}
        variant="outline"
        onPress={handleToggle}
        style={styles.actionButton}
        testID="cron-detail-toggle"
      />
    </View>
  );

  const historySection = (
    <View style={styles.history}>
      <Text style={[styles.historyTitle, { color: colors.mutedForeground }]}>运行历史</Text>
      <RunHistory
        entries={entries}
        loading={historyLoading}
        error={historyError}
        debugMode={debugMode}
      />
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]} testID="cron-detail-body">
      {showInlineHeader ? (
        <View style={[styles.paneHeader, { borderBottomColor: colors.border }]}>
          <Text style={[styles.paneTitle, { color: colors.foreground }]} numberOfLines={1}>
            {job.name}
          </Text>
          <TouchableOpacity
            onPress={handleEdit}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="编辑任务"
            testID="cron-detail-edit"
          >
            <SquarePen size={ICON_SIZE.feature} color={colors.primary} strokeWidth={ICON_STROKE.default} />
          </TouchableOpacity>
        </View>
      ) : null}
      <CronJobForm
        key={job.id}
        readOnly
        initialJob={job}
        onSubmit={async () => {}}
        onToggleEnabled={handleToggle}
        onDelete={handleDelete}
        header={actionBar}
        footer={historySection}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  skeletonWrap: { padding: spacing.lg, gap: spacing.md },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing['2xl'],
  },
  actionButton: { flex: 1 },
  history: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing['2xl'],
    gap: spacing.sm,
  },
  historyTitle: {
    ...fontScale.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.5,
    paddingHorizontal: spacing.xs,
  },
  paneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent',
  },
  paneTitle: {
    ...fontScale.base,
    fontWeight: fontWeight.semibold,
    flex: 1,
    marginRight: spacing.sm,
  },
});
