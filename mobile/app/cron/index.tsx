import React, { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { reportActivity } from '@agent/shared';
import { Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CronJob } from '@agent/shared';
import { useCronJobs } from '../../src/hooks/useCronJobs';
import { useModelList } from '../../src/hooks/useModelList';
import { JobList } from '../../src/components/cron/JobList';
import { JobDetailBody } from '../../src/components/cron/JobDetailBody';
import { MasterDetailSplit } from '../../src/components/layout';
import { useChatAppState } from '../../src/contexts/ChatAppStateContext';
import { useBreakpoint } from '../../src/hooks/useBreakpoint';
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
  const { isMdUp } = useBreakpoint();
  const { ownerFilter } = useChatAppState();
  const { jobs: allJobs, loading, refresh, toggleJob } = useCronJobs();
  const modelList = useModelList();
  const [paneJobId, setPaneJobId] = useState<string | null>(null);

  const jobs = useMemo(() => {
    if (ownerFilter == null) return allJobs;
    return allJobs.filter((j) => j.ownerName === ownerFilter);
  }, [allJobs, ownerFilter]);

  const handleSelect = useCallback(
    (job: CronJob) => {
      hapticLight();
      if (isMdUp) {
        setPaneJobId(job.id);
        return;
      }
      router.push({ pathname: '/cron/[jobId]', params: { jobId: job.id } });
    },
    [router, isMdUp],
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

  const listBody = (
    <JobList
      jobs={jobs}
      loading={loading}
      modelList={modelList}
      onRefresh={refresh}
      onSelect={handleSelect}
      onToggle={toggleJob}
      activeJobId={isMdUp ? paneJobId : null}
      contentPaddingBottom={insets.bottom}
      dense={isMdUp}
    />
  );

  return (
    <View style={styles.container} testID="cron-list-screen">
      <Stack.Screen
        options={{
          headerRight: () => addButton,
          unstable_headerRightItems: () => [glassFree(addButton)],
        }}
      />
      {isMdUp ? (
        <MasterDetailSplit
          testID="cron-master-detail"
          emptyLabel="请选择任务"
          emptyDescription="从左侧列表打开任务详情。"
          master={listBody}
          detail={
            paneJobId ? (
              <JobDetailBody
                jobId={paneJobId}
                showInlineHeader
                onDeleted={() => setPaneJobId(null)}
                onEdit={(jobId, jobJson) => {
                  router.push({
                    pathname: '/cron-form',
                    params: { jobId, jobJson },
                  });
                }}
              />
            ) : null
          }
        />
      ) : (
        listBody
      )}
    </View>
  );
}
