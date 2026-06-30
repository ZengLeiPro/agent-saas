import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { authFetch, type CronJob, type CronJobCreate } from '@agent/shared';
import { useModelList } from '../../hooks/useModelList';
import {
  FormScrollView,
  FormSection,
  FormErrorBanner,
  FormTextField,
  FormSwitchRow,
  FormSegmentedRow,
  FormStepperRow,
  FormPickerRow,
  FormDateTimeRow,
  FormDestructiveButton,
  FormRow,
  type SegmentedOption,
} from '../form';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '../../theme';
import { textEditorBridge } from '../../lib/textEditorBridge';

export interface CronJobFormRef {
  submit: () => void;
  submitting: boolean;
  isDirty: boolean;
}

interface CronJobFormProps {
  initialJob?: CronJob;
  onSubmit: (data: CronJobCreate) => Promise<void>;
  readOnly?: boolean;
  onToggleEnabled?: (enabled: boolean) => void;
  onDelete?: () => void;
}

type ScheduleKind = 'every' | 'cron' | 'at';
type PayloadKind = 'agentTurn' | 'systemEvent';

const SCHEDULE_OPTIONS: SegmentedOption<ScheduleKind>[] = [
  { value: 'every', label: '间隔' },
  { value: 'cron', label: 'Cron' },
  { value: 'at', label: '定时' },
];

const PAYLOAD_OPTIONS: SegmentedOption<PayloadKind>[] = [
  { value: 'agentTurn', label: 'Agent' },
  { value: 'systemEvent', label: '系统事件' },
];

function getInitialState(job?: CronJob) {
  const scheduleKind: ScheduleKind = job?.schedule.kind ?? 'every';
  const everyMinutes =
    job?.schedule.kind === 'every' ? Math.max(1, Math.round(job.schedule.everyMs / 60000)) : 30;
  const cronExpr = job?.schedule.kind === 'cron' ? job.schedule.expr : '0 9 * * *';
  const cronTz = job?.schedule.kind === 'cron' ? job.schedule.tz ?? 'Asia/Shanghai' : 'Asia/Shanghai';
  const atDate = job?.schedule.kind === 'at' ? new Date(job.schedule.atMs) : new Date(Date.now() + 3600000);
  const payloadKind: PayloadKind = job?.payload.kind ?? 'agentTurn';
  const message =
    job?.payload.kind === 'agentTurn'
      ? job.payload.message
      : job?.payload.kind === 'systemEvent'
        ? job.payload.text
        : '';
  const model = (job?.payload.kind === 'agentTurn' && job.payload.model) || '__default__';
  const maxTurnsStr =
    job?.payload.kind === 'agentTurn' && job.payload.maxTurns ? String(job.payload.maxTurns) : '';
  const timeoutStr =
    job?.payload.kind === 'agentTurn' && job.payload.timeoutSeconds
      ? String(job.payload.timeoutSeconds)
      : '';
  const ctxConfig = job?.payload.kind === 'agentTurn' ? job.payload.context : undefined;

  return {
    name: job?.name ?? '',
    description: job?.description ?? '',
    enabled: job?.enabled ?? true,
    scheduleKind,
    everyMinutes,
    cronExpr,
    cronTz,
    atDate,
    payloadKind,
    message,
    model,
    maxTurnsStr,
    timeoutStr,
    ctxSystemPrompt: ctxConfig?.systemPrompt ?? true,
    ctxPersona: ctxConfig?.persona ?? true,
    ctxMemory: ctxConfig?.memory ?? true,
  };
}

async function validateCronServer(
  expr: string,
  tz?: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await authFetch('/api/cron/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expr, tz }),
    });
    return (await res.json()) as { valid: boolean; error?: string };
  } catch {
    return { valid: false, error: '网络错误' };
  }
}

export const CronJobForm = forwardRef<CronJobFormRef, CronJobFormProps>(function CronJobForm(
  { initialJob, onSubmit, readOnly, onToggleEnabled, onDelete },
  ref,
) {
  const colors = useColors();
  const router = useRouter();
  const init = useMemo(() => getInitialState(initialJob), [initialJob]);
  const modelList = useModelList();
  const isEditing = !!initialJob;

  const [name, setName] = useState(init.name);
  const [description, setDescription] = useState(init.description);
  const [enabled, setEnabled] = useState(init.enabled);
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(init.scheduleKind);
  const [everyMinutes, setEveryMinutes] = useState(init.everyMinutes);
  const [cronExpr, setCronExpr] = useState(init.cronExpr);
  const [cronTz, setCronTz] = useState(init.cronTz);
  const [atDate, setAtDate] = useState<Date>(init.atDate);
  const [payloadKind, setPayloadKind] = useState<PayloadKind>(init.payloadKind);
  const [message, setMessage] = useState(init.message);
  const [model, setModel] = useState(init.model);
  const [maxTurnsStr, setMaxTurnsStr] = useState(init.maxTurnsStr);
  const [timeoutStr, setTimeoutStr] = useState(init.timeoutStr);
  const [ctxSystemPrompt, setCtxSystemPrompt] = useState(init.ctxSystemPrompt);
  const [ctxPersona, setCtxPersona] = useState(init.ctxPersona);
  const [ctxMemory, setCtxMemory] = useState(init.ctxMemory);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cronError, setCronError] = useState<string | null>(null);
  const cronValidateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(cronValidateTimer.current), []);

  const handlePayloadKindChange = useCallback(
    (next: PayloadKind) => {
      setPayloadKind(next);
      setMessage(next === init.payloadKind ? init.message : '');
    },
    [init.payloadKind, init.message],
  );

  const flattenedModels = useMemo(() => {
    if (!modelList) return [];
    return modelList.groups.flatMap((g) =>
      g.models.map((m) => ({
        value: `${g.id}/${m.id}`,
        label: modelList.showGroupNames ? `${g.name} / ${m.name}` : m.name,
      })),
    );
  }, [modelList]);

  const modelOptions = useMemo(
    () => [{ value: '__default__', label: '默认模型' }, ...flattenedModels],
    [flattenedModels],
  );

  const handleCronExprChange = useCallback(
    (text: string) => {
      setCronExpr(text);
      setCronError(null);
      clearTimeout(cronValidateTimer.current);
      if (text.trim()) {
        cronValidateTimer.current = setTimeout(async () => {
          const result = await validateCronServer(text, cronTz);
          if (!result.valid) setCronError(result.error ?? '无效的 Cron 表达式');
        }, 500);
      }
    },
    [cronTz],
  );

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setError(null);

    if (!name.trim()) {
      setError('请输入任务名称');
      return;
    }
    if (cronError) {
      setError('请修正 Cron 表达式错误');
      return;
    }

    let schedule: CronJobCreate['schedule'];
    if (scheduleKind === 'every') {
      schedule = { kind: 'every', everyMs: everyMinutes * 60000 };
    } else if (scheduleKind === 'cron') {
      if (!cronExpr.trim()) {
        setError('请输入 Cron 表达式');
        return;
      }
      schedule = { kind: 'cron', expr: cronExpr.trim(), tz: cronTz.trim() || undefined };
    } else {
      schedule = { kind: 'at', atMs: atDate.getTime() };
    }

    let payload: CronJobCreate['payload'];
    if (payloadKind === 'agentTurn') {
      if (!message.trim()) {
        setError('请输入 Agent 提示词');
        return;
      }
      const maxTurns = maxTurnsStr ? parseInt(maxTurnsStr, 10) : undefined;
      const timeoutSeconds = timeoutStr ? parseInt(timeoutStr, 10) : undefined;
      const hasContextOverride = !ctxSystemPrompt || !ctxPersona || !ctxMemory;
      const context = hasContextOverride
        ? {
            ...(!ctxSystemPrompt ? { systemPrompt: false as const } : {}),
            ...(!ctxPersona ? { persona: false as const } : {}),
            ...(!ctxMemory ? { memory: false as const } : {}),
          }
        : undefined;
      payload = {
        kind: 'agentTurn',
        message: message.trim(),
        model: model === '__default__' ? undefined : model,
        maxTurns: maxTurns && !isNaN(maxTurns) ? maxTurns : undefined,
        timeoutSeconds: timeoutSeconds && !isNaN(timeoutSeconds) ? timeoutSeconds : undefined,
        ...(context ? { context } : {}),
      };
    } else {
      if (!message.trim()) {
        setError('请输入事件内容');
        return;
      }
      payload = { kind: 'systemEvent', text: message.trim() };
    }

    const data: CronJobCreate = {
      name: name.trim(),
      description: description.trim() || undefined,
      enabled,
      schedule,
      payload,
      ...(isEditing && initialJob?.notify ? { notify: initialJob.notify } : {}),
    };

    setSubmitting(true);
    try {
      await onSubmit(data);
    } catch (err: any) {
      setError(err?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }, [
    name,
    description,
    enabled,
    scheduleKind,
    everyMinutes,
    cronExpr,
    cronTz,
    cronError,
    atDate,
    payloadKind,
    message,
    model,
    maxTurnsStr,
    timeoutStr,
    ctxSystemPrompt,
    ctxPersona,
    ctxMemory,
    isEditing,
    initialJob,
    onSubmit,
    submitting,
  ]);

  const isDirty =
    name !== init.name ||
    description !== init.description ||
    enabled !== init.enabled ||
    scheduleKind !== init.scheduleKind ||
    everyMinutes !== init.everyMinutes ||
    cronExpr !== init.cronExpr ||
    cronTz !== init.cronTz ||
    atDate.getTime() !== init.atDate.getTime() ||
    payloadKind !== init.payloadKind ||
    message !== init.message ||
    model !== init.model ||
    maxTurnsStr !== init.maxTurnsStr ||
    timeoutStr !== init.timeoutStr ||
    ctxSystemPrompt !== init.ctxSystemPrompt ||
    ctxPersona !== init.ctxPersona ||
    ctxMemory !== init.ctxMemory;

  useImperativeHandle(
    ref,
    () => ({
      submit: () => void handleSubmit(),
      submitting,
      isDirty,
    }),
    [handleSubmit, submitting, isDirty],
  );

  const handleEnabledChange = useCallback(
    (v: boolean) => {
      setEnabled(v);
      onToggleEnabled?.(v);
    },
    [onToggleEnabled],
  );

  const messageLabel = payloadKind === 'agentTurn' ? 'Agent 提示词' : '事件内容';
  const messagePreview = message.trim()
    ? message.length > 50
      ? message.slice(0, 50) + '…'
      : message
    : '点击编辑';

  return (
    <FormScrollView>
      {error ? <FormErrorBanner message={error} /> : null}

      <FormSection header="基本信息">
        <FormTextField
          label="名称"
          value={name}
          onChangeText={setName}
          placeholder="任务名称（必填）"
          disabled={readOnly}
          autoCapitalize="sentences"
        />
        <FormTextField
          label="描述"
          value={description}
          onChangeText={setDescription}
          placeholder="任务描述（可选）"
          disabled={readOnly}
          autoCapitalize="sentences"
        />
        <FormSwitchRow label="启用" value={enabled} onValueChange={handleEnabledChange} />
      </FormSection>

      <FormSection header="调度">
        <FormSegmentedRow
          label="类型"
          value={scheduleKind}
          options={SCHEDULE_OPTIONS}
          onChange={setScheduleKind}
          disabled={readOnly}
        />
        {scheduleKind === 'every' ? (
          <FormStepperRow
            label="执行间隔"
            value={everyMinutes}
            min={1}
            max={1440}
            onValueChange={setEveryMinutes}
            disabled={readOnly}
            format={(v) => `${v} 分钟`}
          />
        ) : null}
        {scheduleKind === 'cron' ? (
          <FormTextField
            label="表达式"
            value={cronExpr}
            onChangeText={handleCronExprChange}
            placeholder="如 0 9 * * *"
            disabled={readOnly}
          />
        ) : null}
        {scheduleKind === 'cron' && cronError ? (
          <FormRow>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.destructive, fontSize: 13 }}>{cronError}</Text>
            </View>
          </FormRow>
        ) : null}
        {scheduleKind === 'cron' ? (
          <FormTextField
            label="时区"
            value={cronTz}
            onChangeText={setCronTz}
            placeholder="Asia/Shanghai"
            disabled={readOnly}
          />
        ) : null}
        {scheduleKind === 'at' ? (
          <FormDateTimeRow
            label="执行时间"
            value={atDate}
            onChange={setAtDate}
            mode="datetime"
            disabled={readOnly}
          />
        ) : null}
      </FormSection>

      <FormSection header="任务内容">
        <FormSegmentedRow
          label="类型"
          value={payloadKind}
          options={PAYLOAD_OPTIONS}
          onChange={handlePayloadKindChange}
          disabled={readOnly}
        />
        <FormRow
          label={messageLabel}
          onPress={readOnly ? undefined : () => {
            textEditorBridge.open(message, messageLabel, messageLabel, (text) => setMessage(text));
            router.push('/text-editor');
          }}
          disabled={readOnly}
        >
          <Text
            style={{
              flex: 1,
              fontSize: 16,
              color: message.trim() ? colors.foreground : colors.mutedForeground,
              textAlign: 'right',
            }}
            numberOfLines={1}
          >
            {messagePreview}
          </Text>
        </FormRow>
        {payloadKind === 'agentTurn' && modelOptions.length > 1 ? (
          <FormPickerRow
            label="模型"
            value={model}
            options={modelOptions}
            onChange={setModel}
            disabled={readOnly}
          />
        ) : null}
        {payloadKind === 'agentTurn' ? (
          <FormTextField
            label="最大轮次"
            value={maxTurnsStr}
            onChangeText={setMaxTurnsStr}
            placeholder="留空使用默认"
            keyboardType="numeric"
            disabled={readOnly}
          />
        ) : null}
        {payloadKind === 'agentTurn' ? (
          <FormTextField
            label="超时秒数"
            value={timeoutStr}
            onChangeText={setTimeoutStr}
            placeholder="留空使用默认"
            keyboardType="numeric"
            disabled={readOnly}
          />
        ) : null}
      </FormSection>

      {payloadKind === 'agentTurn' ? (
        <FormSection header="上下文注入" footer="关闭不需要的上下文可减少 token 消耗">
          <FormSwitchRow
            label="系统提示语（含 SOUL）"
            value={ctxSystemPrompt}
            onValueChange={setCtxSystemPrompt}
            disabled={readOnly}
          />
          <FormSwitchRow
            label="Agent 人格 (PERSONA)"
            value={ctxPersona}
            onValueChange={setCtxPersona}
            disabled={readOnly}
          />
          <FormSwitchRow
            label="长期记忆 (MEMORY.md)"
            value={ctxMemory}
            onValueChange={setCtxMemory}
            disabled={readOnly}
          />
        </FormSection>
      ) : null}

      {onDelete ? <FormDestructiveButton label="删除任务" onPress={onDelete} /> : null}

      {submitting ? (
        <View style={{ paddingHorizontal: 16, marginTop: -8, marginBottom: 16 }}>
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>提交中...</Text>
        </View>
      ) : null}
    </FormScrollView>
  );
});

// Suppress unused-import warnings for Pressable in some configurations.
void Pressable;
