import React, { useRef, useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { X, Check } from 'lucide-react-native';
import type { CronJob, CronJobCreate } from '@agent/shared';
import { useCronJobs } from '../src/hooks/useCronJobs';
import { CronJobForm, type CronJobFormRef } from '../src/components/cron/CronJobForm';
import { useColors } from '../src/theme';
import { glassFree } from '../src/lib/headerItems';

export default function CronFormScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ jobId?: string; jobJson?: string; mode?: string }>();
  const { addJob, updateJob, deleteJob, runJob, toggleJob } = useCronJobs();
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
  const cameFromView = params.mode === 'view';
  const [currentMode, setCurrentMode] = useState<'view' | 'edit'>(
    cameFromView ? 'view' : 'edit',
  );

  const handleSubmit = useCallback(async (data: CronJobCreate) => {
    if (isEditing && params.jobId) {
      await updateJob(params.jobId, data);
    } else {
      await addJob(data);
    }
    router.back();
  }, [isEditing, params.jobId, addJob, updateJob, router]);

  const handleRun = useCallback(() => {
    if (!initialJob) return;
    Alert.alert('立即执行', `确定要立即执行"${initialJob.name}"吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '执行', onPress: () => void runJob(initialJob.id) },
    ]);
  }, [initialJob, runJob]);

  const handleToggleEnabled = useCallback(async () => {
    if (initialJob) await toggleJob(initialJob);
  }, [initialJob, toggleJob]);

  const handleDelete = useCallback(() => {
    if (!initialJob || !params.jobId) return;
    Alert.alert('删除任务', `确定要删除"${initialJob.name}"吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await deleteJob(params.jobId!);
          router.back();
        },
      },
    ]);
  }, [initialJob, params.jobId, deleteJob, router]);

  const handleCloseEdit = useCallback(() => {
    const exitEdit = () => {
      if (cameFromView) {
        setCurrentMode('view');
      } else {
        router.back();
      }
    };

    const dirty = formRef.current?.isDirty ?? false;
    if (dirty) {
      Alert.alert('放弃修改？', '你有未保存的修改，确定要放弃吗？', [
        { text: '继续编辑', style: 'cancel' },
        { text: '放弃', style: 'destructive', onPress: exitEdit },
      ]);
    } else {
      exitEdit();
    }
  }, [cameFromView, router]);

  const isViewMode = currentMode === 'view';

  const title = isViewMode
    ? (initialJob?.name ?? '任务详情')
    : (isEditing ? '编辑任务' : '新建任务');

  const headerLeft = isViewMode
    ? () => (
        <TouchableOpacity onPress={handleRun} activeOpacity={0.7}>
          <Text style={{ fontSize: 17, color: colors.foreground }}>立即执行</Text>
        </TouchableOpacity>
      )
    : () => (
        <TouchableOpacity onPress={handleCloseEdit} activeOpacity={0.7}>
          <X size={24} color={colors.foreground} strokeWidth={2} />
        </TouchableOpacity>
      );

  const headerRight = isViewMode
    ? () => (
        <TouchableOpacity onPress={() => setCurrentMode('edit')} activeOpacity={0.7}>
          <Text style={{ fontSize: 17, color: colors.foreground }}>编辑</Text>
        </TouchableOpacity>
      )
    : () => (
        <TouchableOpacity onPress={() => formRef.current?.submit()} activeOpacity={0.7}>
          <Check size={24} color={colors.foreground} strokeWidth={2} />
        </TouchableOpacity>
      );

  const headerLeftItems = isViewMode
    ? () => [glassFree(
        <TouchableOpacity onPress={handleRun} activeOpacity={0.7}>
          <Text style={{ fontSize: 17, color: colors.foreground }}>立即执行</Text>
        </TouchableOpacity>
      )]
    : () => [glassFree(
        <TouchableOpacity onPress={handleCloseEdit} activeOpacity={0.7}>
          <X size={24} color={colors.foreground} strokeWidth={2} />
        </TouchableOpacity>
      )];

  const headerRightItems = isViewMode
    ? () => [glassFree(
        <TouchableOpacity onPress={() => setCurrentMode('edit')} activeOpacity={0.7}>
          <Text style={{ fontSize: 17, color: colors.foreground }}>编辑</Text>
        </TouchableOpacity>
      )]
    : () => [glassFree(
        <TouchableOpacity onPress={() => formRef.current?.submit()} activeOpacity={0.7}>
          <Check size={24} color={colors.foreground} strokeWidth={2} />
        </TouchableOpacity>
      )];

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title,
          headerLeft,
          unstable_headerLeftItems: headerLeftItems,
          headerRight,
          unstable_headerRightItems: headerRightItems,
        }}
      />
      <CronJobForm
        ref={formRef}
        key={params.jobId ?? 'new'}
        initialJob={initialJob}
        onSubmit={handleSubmit}
        readOnly={isViewMode}
        onToggleEnabled={handleToggleEnabled}
        onDelete={isEditing ? handleDelete : undefined}
      />
    </View>
  );
}
