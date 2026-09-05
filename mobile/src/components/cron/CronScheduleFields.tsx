/**
 * 调度区：间隔分钟 / 5 字段 Cron 表达式 / 定点时间 三选一。
 *
 * Cron 表达式走服务端 `/api/cron/validate` 校验（防抖 500ms），
 * 校验结果就地回显；服务端只回 `{ valid, error }`，不回下次运行时间，
 * 因此这里不做「下次运行」预览（契约缺口已在任务回报里登记）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  CRON_EXPR_PRESETS,
  CRON_SCHEDULE_KIND_OPTIONS,
  CRON_TIMEZONE_PRESETS,
  isFiveFieldCronExpr,
  validateCronExpression,
  type CronJobDraft,
  type CronScheduleKind,
} from '@agent/shared';
import { useColors, fontScale, spacing } from '../../theme';
import {
  FormDateTimeRow,
  FormPickerRow,
  FormRow,
  FormSection,
  FormSegmentedRow,
  FormStepperRow,
  FormTextField,
  type PickerOption,
  type SegmentedOption,
} from '../form';

interface CronScheduleFieldsProps {
  draft: CronJobDraft;
  onPatch: (patch: Partial<CronJobDraft>) => void;
  readOnly?: boolean;
  /** 表达式非法时向父表单回传，阻止提交 */
  onValidityChange: (error: string | null) => void;
}

const SCHEDULE_OPTIONS: SegmentedOption<CronScheduleKind>[] = CRON_SCHEDULE_KIND_OPTIONS.map(
  (option) => ({ value: option.value, label: option.label }),
);

const PRESET_CUSTOM = '__custom__';
const PRESET_OPTIONS: PickerOption[] = [
  { value: PRESET_CUSTOM, label: '自定义' },
  ...CRON_EXPR_PRESETS.map((preset) => ({ value: preset.value, label: preset.label })),
];

const TIMEZONE_OPTIONS: PickerOption[] = CRON_TIMEZONE_PRESETS.map((tz) => ({
  value: tz,
  label: tz,
}));

const VALIDATE_DEBOUNCE_MS = 500;
/** 间隔调度的分钟上限（一天），与 Web 的自由输入相比更适合触屏步进 */
const EVERY_MINUTES_MAX = 1440;

export function CronScheduleFields({
  draft,
  onPatch,
  readOnly,
  onValidityChange,
}: CronScheduleFieldsProps) {
  const colors = useColors();
  const [cronError, setCronError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestRef = useRef(0);

  const report = useCallback(
    (error: string | null) => {
      setCronError(error);
      onValidityChange(error);
    },
    [onValidityChange],
  );

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // 只有 cron 模式才需要表达式校验；切走时立刻清掉遗留的错误，否则会挡住提交
  useEffect(() => {
    if (draft.scheduleKind !== 'cron') {
      clearTimeout(timerRef.current);
      requestRef.current += 1;
      setValidating(false);
      report(null);
      return;
    }
    const expr = draft.cronExpr.trim();
    clearTimeout(timerRef.current);
    if (!expr) {
      report('请输入 Cron 表达式');
      return;
    }
    if (!isFiveFieldCronExpr(expr)) {
      report('Cron 表达式需要 5 个字段：分 时 日 月 周');
      return;
    }
    const requestId = ++requestRef.current;
    setValidating(true);
    report(null);
    timerRef.current = setTimeout(() => {
      void validateCronExpression(expr, draft.cronTz.trim() || undefined).then((result) => {
        if (requestId !== requestRef.current) return;
        setValidating(false);
        report(result.valid ? null : (result.error ?? '无效的 Cron 表达式'));
      });
    }, VALIDATE_DEBOUNCE_MS);
  }, [draft.scheduleKind, draft.cronExpr, draft.cronTz, report]);

  const presetValue = CRON_EXPR_PRESETS.some((p) => p.value === draft.cronExpr.trim())
    ? draft.cronExpr.trim()
    : PRESET_CUSTOM;

  const timezoneOptions = TIMEZONE_OPTIONS.some((o) => o.value === draft.cronTz)
    ? TIMEZONE_OPTIONS
    : [{ value: draft.cronTz, label: draft.cronTz || '跟随服务器' }, ...TIMEZONE_OPTIONS];

  return (
    <FormSection header="调度" footer={draft.scheduleKind === 'cron' ? CRON_FOOTER : undefined}>
      <FormSegmentedRow
        label="类型"
        value={draft.scheduleKind}
        options={SCHEDULE_OPTIONS}
        onChange={(scheduleKind) => onPatch({ scheduleKind })}
        disabled={readOnly}
      />

      {draft.scheduleKind === 'every' ? (
        <FormStepperRow
          label="执行间隔"
          value={draft.everyMinutes}
          min={1}
          max={EVERY_MINUTES_MAX}
          step={5}
          onValueChange={(everyMinutes) => onPatch({ everyMinutes })}
          disabled={readOnly}
          format={(v) => `${v} 分钟`}
        />
      ) : null}

      {draft.scheduleKind === 'cron' ? (
        <FormPickerRow
          label="常用预设"
          value={presetValue}
          options={PRESET_OPTIONS}
          onChange={(value) => {
            if (value !== PRESET_CUSTOM) onPatch({ cronExpr: value });
          }}
          disabled={readOnly}
        />
      ) : null}

      {draft.scheduleKind === 'cron' ? (
        <FormTextField
          label="表达式"
          value={draft.cronExpr}
          onChangeText={(cronExpr) => onPatch({ cronExpr })}
          placeholder="分 时 日 月 周"
          disabled={readOnly}
          invalid={!!cronError}
          required
        />
      ) : null}

      {draft.scheduleKind === 'cron' && (cronError || validating) ? (
        <FormRow>
          <View style={styles.hintWrap}>
            <Text
              style={[
                styles.hint,
                { color: cronError ? colors.dangerFamily.ink : colors.mutedForeground },
              ]}
            >
              {cronError ?? '校验中…'}
            </Text>
          </View>
        </FormRow>
      ) : null}

      {draft.scheduleKind === 'cron' ? (
        <FormPickerRow
          label="时区"
          value={draft.cronTz}
          options={timezoneOptions}
          onChange={(cronTz) => onPatch({ cronTz })}
          disabled={readOnly}
          emptyLabel="跟随服务器"
        />
      ) : null}

      {draft.scheduleKind === 'at' ? (
        <FormDateTimeRow
          label="执行时间"
          value={new Date(draft.atMs)}
          onChange={(date) => onPatch({ atMs: date.getTime() })}
          mode="datetime"
          disabled={readOnly}
        />
      ) : null}
    </FormSection>
  );
}

const CRON_FOOTER = '5 字段：分 时 日 月 周。例如 0 9 * * * 表示每天 9:00。';

const styles = StyleSheet.create({
  hintWrap: {
    flex: 1,
    alignItems: 'flex-start',
  },
  hint: {
    ...fontScale.sm,
    paddingRight: spacing.xs,
  },
});
