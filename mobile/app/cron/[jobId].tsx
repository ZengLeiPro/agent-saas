/**
 * 定时任务详情（phone stack）。md+ 列表页内嵌 JobDetailBody，本路由仍服务窄屏 push。
 */
import React, { useCallback, useMemo } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SquarePen } from 'lucide-react-native';
import { useCronJobs } from '../../src/hooks/useCronJobs';
import { JobDetailBody } from '../../src/components/cron/JobDetailBody';
import { useColors } from '../../src/theme';
import { ICON_SIZE, ICON_STROKE } from '../../src/lib/icons';
import { glassFree } from '../../src/lib/headerItems';

export default function JobDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const id = jobId ?? '';
  const { jobs } = useCronJobs();
  const job = useMemo(() => jobs.find((j) => j.id === id), [jobs, id]);

  const handleEdit = useCallback(() => {
    if (!job) return;
    router.push({
      pathname: '/cron-form',
      params: { jobId: job.id, jobJson: JSON.stringify(job) },
    });
  }, [job, router]);

  const editButton = (
    <TouchableOpacity
      onPress={handleEdit}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="编辑任务"
      testID="cron-detail-edit"
    >
      <SquarePen size={ICON_SIZE.feature} color={colors.primary} strokeWidth={ICON_STROKE.default} />
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          title: job?.name ?? '任务详情',
          headerRight: () => (job ? editButton : null),
          unstable_headerRightItems: () => (job ? [glassFree(editButton)] : []),
        }}
      />
      <JobDetailBody
        jobId={id}
        onDeleted={() => router.back()}
        onEdit={(nextId, jobJson) => {
          router.push({
            pathname: '/cron-form',
            params: { jobId: nextId, jobJson },
          });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
