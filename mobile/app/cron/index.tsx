import React, { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, type LayoutChangeEvent } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { reportActivity } from '@agent/shared';
import { Menu, PanelLeftClose, Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CronJob } from '@agent/shared';
import { useCronJobs } from '../../src/hooks/useCronJobs';
import { useModelList } from '../../src/hooks/useModelList';
import { JobList } from '../../src/components/cron/JobList';
import { JobDetailBody } from '../../src/components/cron/JobDetailBody';
import { MasterDetailSplit, MasterListOverlay } from '../../src/components/layout';
import { useChatAppState } from '../../src/contexts/ChatAppStateContext';
import { useBreakpoint } from '../../src/hooks/useBreakpoint';
import { useMasterListCollapse } from '../../src/hooks/useMasterListCollapse';
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
  const { isMdUp, width: breakpointWidth } = useBreakpoint();
  const { ownerFilter } = useChatAppState();
  const { jobs: allJobs, loading, refresh, toggleJob } = useCronJobs();
  const modelList = useModelList();
  const [paneJobId, setPaneJobId] = useState<string | null>(null);
  const [splitWidth, setSplitWidth] = useState(0);
  const collapse = useMasterListCollapse({
    enabled: isMdUp,
    containerWidth: splitWidth > 0 ? splitWidth : breakpointWidth,
  });

  const jobs = useMemo(() => {
    if (ownerFilter == null) return allJobs;
    return allJobs.filter((j) => j.ownerName === ownerFilter);
  }, [allJobs, ownerFilter]);

  const handleSelect = useCallback(
    (job: CronJob) => {
      hapticLight();
      if (isMdUp) {
        setPaneJobId(job.id);
        collapse.onMasterItemSelected();
        return;
      }
      router.push({ pathname: '/cron/[jobId]', params: { jobId: job.id } });
    },
    [router, isMdUp, collapse],
  );

  const handleAdd = useCallback(() => {
    hapticLight();
    router.push('/cron-form');
  }, [router]);

  const handleSplitLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setSplitWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  }, []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: colors.background,
        },
        headerLeftRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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

  const headerLeft = isMdUp
    ? () =>
        collapse.hideMaster ? (
          <TouchableOpacity
            onPress={collapse.onHamburgerPress}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="打开任务列表"
            testID="cron-master-hamburger"
          >
            <Menu size={ICON_SIZE.feature} color={colors.foreground} strokeWidth={ICON_STROKE.default} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={collapse.togglePersistent}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="折叠任务列表"
            testID="cron-master-collapse"
          >
            <PanelLeftClose size={ICON_SIZE.feature} color={colors.foreground} strokeWidth={ICON_STROKE.default} />
          </TouchableOpacity>
        )
    : undefined;

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
    <View style={styles.container} testID="cron-list-screen" onLayout={isMdUp ? handleSplitLayout : undefined}>
      <Stack.Screen
        options={{
          headerLeft,
          unstable_headerLeftItems: headerLeft ? () => [glassFree(headerLeft())] : undefined,
          headerRight: () => addButton,
          unstable_headerRightItems: () => [glassFree(addButton)],
        }}
      />
      {isMdUp ? (
        <>
          <MasterDetailSplit
            testID="cron-master-detail"
            emptyLabel="请选择任务"
            emptyDescription="从左侧列表打开任务详情。"
            masterHidden={collapse.hideMaster}
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
          <MasterListOverlay
            visible={collapse.masterOverlayOpen}
            onDismiss={collapse.dismissMasterOverlay}
            testID="cron-master-overlay"
          >
            {listBody}
          </MasterListOverlay>
        </>
      ) : (
        listBody
      )}
    </View>
  );
}
