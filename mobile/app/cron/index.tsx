import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { reportActivity } from '@agent/shared';
import { Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CronJob } from '@agent/shared';
import { useCronJobs } from '../../src/hooks/useCronJobs';
import { JobList } from '../../src/components/cron/JobList';
import { useChatAppState } from '../../src/contexts/ChatAppStateContext';
import { useColors } from '../../src/theme';
import { hapticLight } from '../../src/lib/haptics';
import { glassFree } from '../../src/lib/headerItems';

export default function CronListScreen() {
  useFocusEffect(useCallback(() => { reportActivity('page_viewed', { detail: '定时任务' }); }, []));
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { ownerFilter } = useChatAppState();
  const { jobs: allJobs, loading, refresh, toggleJob } = useCronJobs();

  const jobs = useMemo(() => {
    if (ownerFilter == null) return allJobs;
    return allJobs.filter((j) => j.ownerName === ownerFilter);
  }, [allJobs, ownerFilter]);

  const handleSelect = useCallback((job: CronJob) => {
    hapticLight();
    router.push({
      pathname: '/cron-form',
      params: { jobId: job.id, jobJson: JSON.stringify(job), mode: 'view' },
    });
  }, [router]);

  const handleAdd = useCallback(() => {
    hapticLight();
    router.push('/cron-form');
  }, [router]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
  }), [colors]);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <TouchableOpacity onPress={handleAdd} activeOpacity={0.7}>
              <Plus size={24} color={colors.foreground} strokeWidth={2} />
            </TouchableOpacity>
          ),
          unstable_headerRightItems: () => [glassFree(
            <TouchableOpacity onPress={handleAdd} activeOpacity={0.7}>
              <Plus size={24} color={colors.foreground} strokeWidth={2} />
            </TouchableOpacity>
          )],
        }}
      />
      <JobList
        jobs={jobs}
        loading={loading}
        onRefresh={refresh}
        onSelect={handleSelect}
        onToggle={toggleJob}
        contentPaddingBottom={insets.bottom}
      />
    </View>
  );
}
