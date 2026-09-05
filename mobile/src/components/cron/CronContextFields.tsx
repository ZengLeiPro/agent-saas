/**
 * 任务内容与上下文注入区：任务类型、提示词/事件文本、模型、最大轮次、超时、
 * 以及「系统提示语 / PERSONA / MEMORY.md」三个注入开关。
 *
 * 关于 0 值：Web 的超时输入允许 `0 = 不设置超时`，移动端把 0 归给「使用默认」
 * 这一档（步进器上没有第二个空位表达「留空」），需要关闭超时请去 Web 设置。
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import {
  CRON_MODEL_DEFAULT_VALUE,
  CRON_PAYLOAD_KIND_OPTIONS,
  type CronJobDraft,
  type CronPayloadKind,
  type ModelList,
} from '@agent/shared';
import { useColors, fontScale } from '../../theme';
import {
  formatCronMaxTurns,
  formatCronTimeout,
  fromCronStepperValue,
  toCronStepperValue,
} from './cronStepper';
import {
  FormPickerRow,
  FormRow,
  FormSection,
  FormSegmentedRow,
  FormStepperRow,
  FormSwitchRow,
  type PickerOption,
  type SegmentedOption,
} from '../form';

interface CronContextFieldsProps {
  draft: CronJobDraft;
  onPatch: (patch: Partial<CronJobDraft>) => void;
  modelList: ModelList | null;
  readOnly?: boolean;
  /** 打开全屏文本编辑器编辑提示词/事件内容 */
  onEditMessage: () => void;
}

const PAYLOAD_OPTIONS: SegmentedOption<CronPayloadKind>[] = CRON_PAYLOAD_KIND_OPTIONS.map(
  (option) => ({ value: option.value, label: option.label }),
);

/** 提示词在行内只露一行，超出截断 */
const MESSAGE_PREVIEW_MAX = 50;
const MAX_TURNS_MAX = 50;
const TIMEOUT_MAX_SECONDS = 7200;
const TIMEOUT_STEP_SECONDS = 300;

function buildModelOptions(modelList: ModelList | null): PickerOption[] {
  const flattened = (modelList?.groups ?? []).flatMap((group) =>
    group.models.map((model) => ({
      value: `${group.id}/${model.id}`,
      label: modelList?.showGroupNames ? `${group.name} / ${model.name}` : model.name,
    })),
  );
  return [{ value: CRON_MODEL_DEFAULT_VALUE, label: '使用默认模型' }, ...flattened];
}

export function CronContextFields({
  draft,
  onPatch,
  modelList,
  readOnly,
  onEditMessage,
}: CronContextFieldsProps) {
  const colors = useColors();
  const isAgentTurn = draft.payloadKind === 'agentTurn';
  const modelOptions = buildModelOptions(modelList);
  const messageLabel = isAgentTurn ? 'Agent 提示词' : '事件内容';
  const trimmed = draft.message.trim();
  const preview = trimmed
    ? trimmed.length > MESSAGE_PREVIEW_MAX
      ? `${trimmed.slice(0, MESSAGE_PREVIEW_MAX)}…`
      : trimmed
    : readOnly
      ? '未填写'
      : '点击编辑';

  return (
    <>
      <FormSection header="任务内容">
        <FormSegmentedRow
          label="任务类型"
          value={draft.payloadKind}
          options={PAYLOAD_OPTIONS}
          onChange={(payloadKind) => onPatch({ payloadKind })}
          disabled={readOnly}
        />

        <FormRow
          label={messageLabel}
          required
          onPress={readOnly ? undefined : onEditMessage}
          disabled={readOnly}
        >
          <Text
            style={[
              styles.preview,
              { color: trimmed ? colors.foreground : colors.mutedForeground },
            ]}
            numberOfLines={1}
          >
            {preview}
          </Text>
        </FormRow>

        {isAgentTurn && modelOptions.length > 1 ? (
          <FormPickerRow
            label="模型"
            value={draft.model}
            options={modelOptions}
            onChange={(model) => onPatch({ model })}
            disabled={readOnly}
          />
        ) : null}

        {isAgentTurn ? (
          <FormStepperRow
            label="最大轮次"
            value={toCronStepperValue(draft.maxTurns)}
            min={0}
            max={MAX_TURNS_MAX}
            onValueChange={(value) => onPatch({ maxTurns: fromCronStepperValue(value) })}
            disabled={readOnly}
            format={formatCronMaxTurns}
          />
        ) : null}

        {isAgentTurn ? (
          <FormStepperRow
            label="超时"
            value={toCronStepperValue(draft.timeoutSeconds)}
            min={0}
            max={TIMEOUT_MAX_SECONDS}
            step={TIMEOUT_STEP_SECONDS}
            onValueChange={(value) => onPatch({ timeoutSeconds: fromCronStepperValue(value) })}
            disabled={readOnly}
            format={formatCronTimeout}
          />
        ) : null}
      </FormSection>

      {isAgentTurn ? (
        <FormSection
          header="上下文注入"
          footer="关闭不需要的上下文可减少 token 消耗。全部关闭后 Agent 仅使用基础能力执行任务。"
        >
          <FormSwitchRow
            label="系统提示语（含 SOUL 规范）"
            value={draft.ctxSystemPrompt}
            onValueChange={(ctxSystemPrompt) => onPatch({ ctxSystemPrompt })}
            disabled={readOnly}
          />
          <FormSwitchRow
            label="Agent 人格 (PERSONA)"
            value={draft.ctxPersona}
            onValueChange={(ctxPersona) => onPatch({ ctxPersona })}
            disabled={readOnly}
          />
          <FormSwitchRow
            label="长期记忆 (MEMORY.md)"
            value={draft.ctxMemory}
            onValueChange={(ctxMemory) => onPatch({ ctxMemory })}
            disabled={readOnly}
          />
        </FormSection>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  preview: {
    ...fontScale.base,
    flex: 1,
    textAlign: 'right',
  },
});
