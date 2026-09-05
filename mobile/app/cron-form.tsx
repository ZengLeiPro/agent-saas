/**
 * 定时任务的创建 / 编辑页（查看走 `/cron/[jobId]` 详情页）。
 *
 * 提交由 header 的 ✓ 通过 imperative ref 触发；关闭时若草稿已脏，
 * 先用 ActionSheet 做一次「放弃修改」确认。
 */
import React, { useRef, useMemo, useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { X, Check } from 'lucide-react-native';
import type { CronJob, CronJobCreate } from '@agent/shared';
import { useCronJobs } from '../src/hooks/useCronJobs';
import { CronJobForm, type CronJobFormRef } from '../src/components/cron/CronJobForm';
import { showActionMenu } from '../src/lib/prompt';
import { useColors } from '../src/theme';
import { ICON_SIZE, ICON_STROKE } from '../src/lib/icons';
import { glassFree } from '../src/lib/headerItems';

export default function CronFormScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ jobId?: string; jobJson?: string }>();
  const { addJob, updateJob } = useCronJobs();
  const formRef = useRef<CronJobFormRef>(null);

  const initialJob = useMemo(() => {
    if (!params.jobJson) return undefined;
    try {
      return JSON.parse(params.jobJson) as CronJob;
    } catch {
      return undefined;
    }
  }, [params.jobJson]);

  const isEditing = !!params.jobId;

  const handleSubmit = useCallback(
    async (data: CronJobCreate) => {
      if (isEditing && params.jobId) {
        await updateJob(params.jobId, data);
      } else {
        await addJob(data);
      }
      router.back();
    },
    [isEditing, params.jobId, addJob, updateJob, router],
  );

  const handleClose = useCallback(() => {
    if (!formRef.current?.isDirty) {
      router.back();
      return;
    }
    showActionMenu({
      title: '放弃修改？',
      message: '你有未保存的修改，返回后将丢失。',
      actions: [{ label: '放弃修改', destructive: true, onPress: () => router.back() }],
      cancelText: '继续编辑',
    });
  }, [router]);

  const closeButton = (
    <TouchableOpacity
      onPress={handleClose}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="关闭"
      testID="cron-form-close"
    >
      <X size={ICON_SIZE.feature} color={colors.foreground} strokeWidth={ICON_STROKE.default} />
    </TouchableOpacity>
  );

  const submitButton = (
    <TouchableOpacity
      onPress={() => formRef.current?.submit()}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="保存"
      testID="cron-form-submit"
    >
      <Check size={ICON_SIZE.feature} color={colors.foreground} strokeWidth={ICON_STROKE.default} />
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: isEditing ? '编辑任务' : '新建任务',
          headerLeft: () => closeButton,
          unstable_headerLeftItems: () => [glassFree(closeButton)],
          headerRight: () => submitButton,
          unstable_headerRightItems: () => [glassFree(submitButton)],
        }}
      />
      <CronJobForm
        ref={formRef}
        key={params.jobId ?? 'new'}
        initialJob={initialJob}
        onSubmit={handleSubmit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
