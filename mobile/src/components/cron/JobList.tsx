/**
 * 定时任务列表 —— 一行一张卡：状态徽章 + 启停开关常驻，
 * 「立即运行 / 编辑 / 删除」这类有副作用的动作都收进详情页（与 Web JobList 同一取舍）。
 */
import React, { useCallback, useMemo } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import type { CronJob, ModelList } from '@agent/shared';
import { cronJobStatusLabel, cronJobStatusTone, cronJobSubtitle } from '@agent/shared';
import { useColors, spacing } from '../../theme';
import { EntityIcons } from '../../lib/icons';
import { hapticLight } from '../../lib/haptics';
import { EmptyState } from '../ui/EmptyState';
import { ListRow } from '../ui/ListRow';
import { Skeleton } from '../ui/Skeleton';
import { StatusBadge } from '../ui/StatusBadge';

interface JobListProps {
  jobs: CronJob[];
  loading: boolean;
  modelList?: ModelList | null;
  listRef?: React.RefObject<FlashListRef<CronJob> | null>;
  onRefresh: () => Promise<void>;
  onSelect: (job: CronJob) => void;
  onToggle: (job: CronJob) => Promise<void>;
  contentPaddingTop?: number;
  contentPaddingBottom?: number;
}

/** 骨架屏行数：够撑满一屏，不至于让首屏闪成空态 */
const SKELETON_ROWS = 5;
const SKELETON_ROW_HEIGHT = 72;

function JobRow({
  job,
  modelList,
  onSelect,
  onToggle,
}: {
  job: CronJob;
  modelList?: ModelList | null;
  onSelect: (job: CronJob) => void;
  onToggle: (job: CronJob) => Promise<void>;
}) {
  const running = !!job.state.runningAtMs;

  const handleToggle = useCallback(() => {
    hapticLight();
    void onToggle(job);
  }, [job, onToggle]);

  return (
    <ListRow
      title={job.name}
      subtitle={cronJobSubtitle(job, { modelList })}
      titleTestID={`cron-job-${job.id}`}
      accessory={
        <StatusBadge status={cronJobStatusTone(job)} label={cronJobStatusLabel(job)} size="sm" />
      }
      switchValue={job.enabled}
      onSwitchChange={handleToggle}
      // 运行中不给切换：这一轮已经在跑，切开关只会造成「以为停下了」的错觉
      switchDisabled={running}
      onPress={() => onSelect(job)}
      style={styles.row}
    />
  );
}

export function JobList({
  jobs,
  loading,
  modelList,
  listRef,
  onRefresh,
  onSelect,
  onToggle,
  contentPaddingTop,
  contentPaddingBottom,
}: JobListProps) {
  const colors = useColors();

  const contentContainerStyle = useMemo(
    () => ({
      padding: spacing.md,
      ...(contentPaddingTop != null ? { paddingTop: contentPaddingTop } : {}),
      ...(contentPaddingBottom != null ? { paddingBottom: contentPaddingBottom } : {}),
    }),
    [contentPaddingTop, contentPaddingBottom],
  );

  if (loading && jobs.length === 0) {
    return (
      <View style={styles.skeletonWrap} testID="cron-job-list-skeleton">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} height={SKELETON_ROW_HEIGHT} style={styles.skeletonRow} />
        ))}
      </View>
    );
  }

  return (
    <FlashList
      testID="cron-job-list"
      ref={listRef}
      data={jobs}
      drawDistance={250}
      overrideProps={{ initialDrawBatchSize: 10 }}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <JobRow job={item} modelList={modelList} onSelect={onSelect} onToggle={onToggle} />
      )}
      contentContainerStyle={contentContainerStyle}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={colors.primary} />
      }
      ListEmptyComponent={
        <EmptyState
          icon={EntityIcons.cron}
          title="暂无定时任务"
          description="创建定时任务后，Agent 会按计划自动执行并把结果通知你。"
          testID="cron-job-list-empty"
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  row: {
    marginBottom: spacing.sm,
  },
  skeletonWrap: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  skeletonRow: {
    width: '100%',
  },
});
