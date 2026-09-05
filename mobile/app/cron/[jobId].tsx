/**
 * 定时任务详情：只读的完整字段 + 「立即运行 / 启停 / 编辑 / 删除」+ 运行历史。
 *
 * 只读字段直接复用 `CronJobForm`（readOnly），动作栏与运行历史通过它的
 * header/footer 插槽挂进同一个滚动容器，避免嵌套两层 ScrollView。
 */
import React, { useCallback, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Pause, Play, SquarePen } from 'lucide-react-native';
import { isDebugModeAvailable } from '@agent/shared';
import { useCronJobs, useRunHistory } from '../../src/hooks/useCronJobs';
import { CronJobForm } from '../../src/components/cron/CronJobForm';
import { RunHistory } from '../../src/components/cron/RunHistory';
import { Button } from '../../src/components/ui/Button';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { Skeleton } from '../../src/components/ui/Skeleton';
import { showActionMenu } from '../../src/lib/prompt';
import { useAuth } from '../../src/contexts/AuthContext';
import { useColors, spacing, fontScale, fontWeight } from '../../src/theme';
import { ICON_SIZE, ICON_STROKE, EntityIcons } from '../../src/lib/icons';
import { glassFree } from '../../src/lib/headerItems';

const SKELETON_ROWS = 4;
const SKELETON_ROW_HEIGHT = 56;

export default function JobDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const { jobs, loading, runJob, toggleJob, deleteJob } = useCronJobs();
  const { entries, loading: historyLoading, error: historyError, reload } = useRunHistory(
    jobId ?? null,
  );

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
    router.push({
      pathname: '/cron-form',
      params: { jobId: job.id, jobJson: JSON.stringify(job) },
    });
  }, [job, router]);

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
            void deleteJob(job.id).then(() => router.back());
          },
        },
      ],
    });
  }, [job, deleteJob, router]);

  if (!job) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: '任务详情' }} />
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

  const editButton = (
    <TouchableOpacity
      onPress={handleEdit}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="编辑任务"
      testID="cron-detail-edit"
    >
      <SquarePen
        size={ICON_SIZE.feature}
        color={colors.primary}
        strokeWidth={ICON_STROKE.default}
      />
    </TouchableOpacity>
  );

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
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          title: job.name,
          headerRight: () => editButton,
          unstable_headerRightItems: () => [glassFree(editButton)],
        }}
      />
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
  container: {
    flex: 1,
  },
  skeletonWrap: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing['2xl'],
  },
  actionButton: {
    flex: 1,
  },
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
});
