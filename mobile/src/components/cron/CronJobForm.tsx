/**
 * 定时任务表单 —— 字段集与 Web `web/src/components/CronManager/JobForm.tsx` 对齐。
 *
 * 表单状态是一份扁平草稿（`@agent/shared` 的 `CronJobDraft`），
 * 草稿 → 提交体、context 省略、notify 组装、钉钉目标校验全部在 shared 的纯函数里，
 * 本文件只负责把字段绑到控件、拆分区块，并对外暴露 imperative 的 submit/isDirty。
 */
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  buildCronJobCreate,
  cronJobToDraft,
  isCronDraftDirty,
  type CronJob,
  type CronJobCreate,
  type CronJobDraft,
} from '@agent/shared';
import { useColors, spacing, fontScale } from '../../theme';
import { useModelList } from '../../hooks/useModelList';
import { useCronDingtalkSessions } from '../../hooks/useCronJobs';
import { textEditorBridge } from '../../lib/textEditorBridge';
import {
  FormDestructiveButton,
  FormErrorBanner,
  FormScrollView,
  FormSection,
  FormSwitchRow,
  FormTextField,
} from '../form';
import { CronContextFields } from './CronContextFields';
import { CronNotificationFields } from './CronNotificationFields';
import { CronScheduleFields } from './CronScheduleFields';

export interface CronJobFormRef {
  submit: () => void;
  submitting: boolean;
  isDirty: boolean;
}

interface CronJobFormProps {
  initialJob?: CronJob;
  onSubmit: (data: CronJobCreate) => Promise<void>;
  readOnly?: boolean;
  /** 只读态下切换启用开关会立刻下发（与详情页的启停一致） */
  onToggleEnabled?: (enabled: boolean) => void;
  onDelete?: () => void;
  /** 表单顶部额外区块（详情页的动作栏） */
  header?: React.ReactNode;
  /** 表单底部额外区块（详情页的运行历史）——同一个滚动容器，避免嵌套滚动 */
  footer?: React.ReactNode;
}

export const CronJobForm = forwardRef<CronJobFormRef, CronJobFormProps>(function CronJobForm(
  { initialJob, onSubmit, readOnly, onToggleEnabled, onDelete, header, footer },
  ref,
) {
  const colors = useColors();
  const router = useRouter();
  const modelList = useModelList();

  // 初始草稿只在挂载时算一次：外层用 key={jobId} 强制重建，不做 useEffect 回填
  const initialDraft = useMemo(() => cronJobToDraft(initialJob), [initialJob]);
  const [draft, setDraft] = useState<CronJobDraft>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cronErrorRef = useRef<string | null>(null);

  const sessions = useCronDingtalkSessions(draft.notifyEnabled);

  const patch = useCallback((next: Partial<CronJobDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  const handleEnabledChange = useCallback(
    (enabled: boolean) => {
      patch({ enabled });
      onToggleEnabled?.(enabled);
    },
    [patch, onToggleEnabled],
  );

  const handleEditMessage = useCallback(() => {
    const label = draft.payloadKind === 'agentTurn' ? 'Agent 提示词' : '事件内容';
    textEditorBridge.open(draft.message, label, label, (message) => patch({ message }));
    router.push('/text-editor');
  }, [draft.payloadKind, draft.message, patch, router]);

  const handleCronValidity = useCallback((cronError: string | null) => {
    cronErrorRef.current = cronError;
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setError(null);
    if (cronErrorRef.current) {
      setError(cronErrorRef.current);
      return;
    }
    const built = buildCronJobCreate(draft, { keepExistingNotify: !!initialJob?.notify });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(built.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [draft, initialJob?.notify, onSubmit, submitting]);

  const isDirty = isCronDraftDirty(draft, initialDraft);

  useImperativeHandle(
    ref,
    () => ({ submit: () => void handleSubmit(), submitting, isDirty }),
    [handleSubmit, submitting, isDirty],
  );

  return (
    <FormScrollView testID="cron-job-form">
      {error ? <FormErrorBanner message={error} /> : null}
      {header}

      <FormSection header="基本信息">
        <FormTextField
          label="名称"
          value={draft.name}
          onChangeText={(name) => patch({ name })}
          placeholder="例如：每日报告"
          disabled={readOnly}
          autoCapitalize="sentences"
          required
        />
        <FormTextField
          label="描述"
          value={draft.description}
          onChangeText={(description) => patch({ description })}
          placeholder="任务描述（可选）"
          disabled={readOnly}
          autoCapitalize="sentences"
        />
        <FormSwitchRow label="启用" value={draft.enabled} onValueChange={handleEnabledChange} />
      </FormSection>

      <CronScheduleFields
        draft={draft}
        onPatch={patch}
        readOnly={readOnly}
        onValidityChange={handleCronValidity}
      />

      <CronContextFields
        draft={draft}
        onPatch={patch}
        modelList={modelList}
        readOnly={readOnly}
        onEditMessage={handleEditMessage}
      />

      <CronNotificationFields
        draft={draft}
        onPatch={patch}
        sessions={sessions}
        readOnly={readOnly}
      />

      {onDelete ? <FormDestructiveButton label="删除任务" onPress={onDelete} /> : null}

      {footer}

      {submitting ? (
        <View style={styles.status}>
          <Text style={[styles.statusText, { color: colors.mutedForeground }]}>提交中…</Text>
        </View>
      ) : null}
    </FormScrollView>
  );
});

const styles = StyleSheet.create({
  status: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  statusText: {
    ...fontScale.sm,
  },
});
