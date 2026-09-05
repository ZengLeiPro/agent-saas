import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { reportActivity } from '@agent/shared';
import { Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CronJob } from '@agent/shared';
import { useCronJobs } from '../../src/hooks/useCronJobs';
import { useModelList } from '../../src/hooks/useModelList';
import { JobList } from '../../src/components/cron/JobList';
import { useChatAppState } from '../../src/contexts/ChatAppStateContext';
import { useColors } from '../../src/theme';
import { ICON_SIZE, ICON_STROKE } from '../../src/lib/icons';
import { hapticLight } from '../../src/lib/haptics';
import { glassFree } from '../../src/lib/headerItems';

export default function CronListScreen() {
  useFocusEffect(
    useCallback(() => {
      reportActivity('page_viewed', { detail: '任务中心' });
    }, []),
  );
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { ownerFilter } = useChatAppState();
  const { jobs: allJobs, loading, refresh, toggleJob } = useCronJobs();
  const modelList = useModelList();

  const jobs = useMemo(() => {
    if (ownerFilter == null) return allJobs;
    return allJobs.filter((j) => j.ownerName === ownerFilter);
  }, [allJobs, ownerFilter]);

  const handleSelect = useCallback(
    (job: CronJob) => {
      hapticLight();
      router.push({ pathname: '/cron/[jobId]', params: { jobId: job.id } });
    },
    [router],
  );

  const handleAdd = useCallback(() => {
    hapticLight();
    router.push('/cron-form');
  }, [router]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: colors.background,
        },
      }),
    [colors],
  );

  const addButton = (
    <TouchableOpacity
      onPress={handleAdd}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="新建定时任务"
      testID="cron-add-button"
    >
      <Plus size={ICON_SIZE.feature} color={colors.foreground} strokeWidth={ICON_STROKE.default} />
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => addButton,
          unstable_headerRightItems: () => [glassFree(addButton)],
        }}
      />
      <JobList
        jobs={jobs}
        loading={loading}
        modelList={modelList}
        onRefresh={refresh}
        onSelect={handleSelect}
        onToggle={toggleJob}
        contentPaddingBottom={insets.bottom}
      />
    </View>
  );
}
