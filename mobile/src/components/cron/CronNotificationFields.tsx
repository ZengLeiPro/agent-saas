/**
 * 通知区：渠道（Web / 钉钉 / 两者）、钉钉发送方式（sessionWebhook / 私聊 / 群聊）
 * 与对应的 conversationId / userId / chatId，以及成功、失败是否通知。
 *
 * 与 Web JobForm 一致的两条自动填充：需要钉钉通知时，session 模式默认选中
 * 第一个仍持有 webhook 的会话；user 模式默认填第一个能拿到 senderId 的会话。
 */
import React, { useEffect, useMemo } from 'react';
import {
  CRON_DINGTALK_MODE_OPTIONS,
  CRON_NOTIFY_CHANNEL_OPTIONS,
  cronNotifyNeedsDingtalk,
  type CronDingtalkMode,
  type CronJobDraft,
  type DingtalkSessionSummary,
  type NotifyConfig,
} from '@agent/shared';
import {
  FormPickerRow,
  FormSection,
  FormSwitchRow,
  FormTextField,
  type PickerOption,
} from '../form';

interface CronNotificationFieldsProps {
  draft: CronJobDraft;
  onPatch: (patch: Partial<CronJobDraft>) => void;
  sessions: DingtalkSessionSummary[];
  readOnly?: boolean;
}

const CHANNEL_OPTIONS: PickerOption[] = CRON_NOTIFY_CHANNEL_OPTIONS.map((option) => ({
  value: option.value,
  label: option.label,
}));

const MODE_OPTIONS: PickerOption[] = CRON_DINGTALK_MODE_OPTIONS.map((option) => ({
  value: option.value,
  label: option.label,
}));

const WEB_CHANNEL_FOOTER = 'Web 通知目前仅用于调试输出（服务端控制台）。';

function sessionLabel(session: DingtalkSessionSummary): string {
  const kind = session.conversationType === '1' ? '私聊' : '群聊';
  const time = session.lastUpdatedAt ? ` · ${session.lastUpdatedAt}` : '';
  return `${session.senderNick}（${kind}）${time}`;
}

export function CronNotificationFields({
  draft,
  onPatch,
  sessions,
  readOnly,
}: CronNotificationFieldsProps) {
  const needsDingtalk = cronNotifyNeedsDingtalk(draft.notifyEnabled, draft.notifyChannel);
  const webhookCandidates = useMemo(() => sessions.filter((s) => s.hasWebhook), [sessions]);
  const modeHint = CRON_DINGTALK_MODE_OPTIONS.find((o) => o.value === draft.dingtalkMode)?.hint;

  // session 模式：默认选中第一个仍持有 webhook 的会话
  useEffect(() => {
    if (!needsDingtalk || readOnly) return;
    if (draft.dingtalkMode !== 'session') return;
    if (draft.dingtalkConversationId.trim()) return;
    const first = webhookCandidates[0];
    if (first) onPatch({ dingtalkConversationId: first.conversationId });
  }, [
    needsDingtalk,
    readOnly,
    draft.dingtalkMode,
    draft.dingtalkConversationId,
    webhookCandidates,
    onPatch,
  ]);

  // user 模式：默认填第一个能拿到 senderId 的会话
  useEffect(() => {
    if (!needsDingtalk || readOnly) return;
    if (draft.dingtalkMode !== 'user') return;
    if (draft.dingtalkUserId.trim()) return;
    const candidate = sessions.find((s) => s.senderId?.trim());
    if (candidate?.senderId) onPatch({ dingtalkUserId: candidate.senderId });
  }, [needsDingtalk, readOnly, draft.dingtalkMode, draft.dingtalkUserId, sessions, onPatch]);

  const conversationOptions: PickerOption[] = webhookCandidates.map((session) => ({
    value: session.conversationId,
    label: sessionLabel(session),
  }));

  return (
    <FormSection
      header="通知"
      footer={needsDingtalk ? modeHint : draft.notifyEnabled ? WEB_CHANNEL_FOOTER : undefined}
    >
      <FormSwitchRow
        label="启用通知"
        value={draft.notifyEnabled}
        onValueChange={(notifyEnabled) => onPatch({ notifyEnabled })}
        disabled={readOnly}
      />

      {draft.notifyEnabled ? (
        <FormPickerRow
          label="通知渠道"
          value={draft.notifyChannel}
          options={CHANNEL_OPTIONS}
          onChange={(value) => onPatch({ notifyChannel: value as NotifyConfig['channel'] })}
          disabled={readOnly}
        />
      ) : null}

      {needsDingtalk ? (
        <FormPickerRow
          label="钉钉发送方式"
          value={draft.dingtalkMode}
          options={MODE_OPTIONS}
          onChange={(value) => onPatch({ dingtalkMode: value as CronDingtalkMode })}
          disabled={readOnly}
        />
      ) : null}

      {needsDingtalk && draft.dingtalkMode === 'session' && conversationOptions.length > 0 ? (
        <FormPickerRow
          label="会话"
          value={draft.dingtalkConversationId}
          options={conversationOptions}
          onChange={(dingtalkConversationId) => onPatch({ dingtalkConversationId })}
          disabled={readOnly}
          emptyLabel="选择一个已建立的钉钉会话"
          required
        />
      ) : null}

      {needsDingtalk && draft.dingtalkMode === 'session' && conversationOptions.length === 0 ? (
        <FormTextField
          label="conversationId"
          value={draft.dingtalkConversationId}
          onChangeText={(dingtalkConversationId) => onPatch({ dingtalkConversationId })}
          placeholder="先在钉钉里给机器人发条消息"
          disabled={readOnly}
          required
        />
      ) : null}

      {needsDingtalk && draft.dingtalkMode === 'user' ? (
        <FormTextField
          label="userId"
          value={draft.dingtalkUserId}
          onChangeText={(dingtalkUserId) => onPatch({ dingtalkUserId })}
          placeholder="例如：user123456"
          disabled={readOnly}
          required
        />
      ) : null}

      {needsDingtalk && draft.dingtalkMode === 'chat' ? (
        <FormTextField
          label="chatId"
          value={draft.dingtalkChatId}
          onChangeText={(dingtalkChatId) => onPatch({ dingtalkChatId })}
          placeholder="例如：cidxxxxxxxx=="
          disabled={readOnly}
          required
        />
      ) : null}

      {draft.notifyEnabled ? (
        <FormSwitchRow
          label="成功时通知"
          value={draft.notifyOnSuccess}
          onValueChange={(notifyOnSuccess) => onPatch({ notifyOnSuccess })}
          disabled={readOnly}
        />
      ) : null}

      {draft.notifyEnabled ? (
        <FormSwitchRow
          label="失败时通知"
          value={draft.notifyOnError}
          onValueChange={(notifyOnError) => onPatch({ notifyOnError })}
          disabled={readOnly}
        />
      ) : null}
    </FormSection>
  );
}
