/**
 * 对话与模型（`settings/chat-model`）—— 对齐 Web `SettingsModal` 的 `GeneralSection`。
 *
 * 与 Web 同源的项：
 * - 新建会话默认模型：`GET /api/models` + `PATCH /api/auth/me/preferences`
 *   （shared `saveUserPreferences`），选择器直接复用 ChatInput 的 `ModelPicker`，
 *   可选范围与锁组逻辑都走 shared 纯函数，不在设置页另起一套。
 *
 * - 操作前确认与详细执行过程：与 Web 使用相同的账户偏好和调试模式接口。
 *
 * - 系统推送通知：对应 Web 在本分区挂的 `BrowserNotificationSettings`（浏览器桌面通知），
 *   移动端等价物是 iOS 系统推送（APNs），实现在 `PushNotificationSettings`。
 *
 * 刻意差异：
 * - 系统推送本轮只在 iOS 落地，其余平台整组隐藏，不留点不动的假入口。
 * - 「自动播放语音回复」是移动端独有偏好（本机存储，Web 无对应项），
 *   放在这里给一个持久化入口，与会话顶栏的开关同一份状态。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { authFetch, isDebugModeAvailable, saveUserPreferences } from '@agent/shared';
import { useAuth } from '../../src/contexts/AuthContext';
import { useModelList } from '../../src/hooks/useModelList';
import { useTtsPlayer } from '../../src/hooks/useTtsPlayer';
import { ModelPicker } from '../../src/components/chat/ModelPicker';
import { ListRow } from '../../src/components/ui';
import { SettingsGroup, SettingsScrollView } from '../../src/components/settings/SettingsSections';
import { PushNotificationSettings } from '../../src/components/settings/PushNotificationSettings';
import {
  preferencesForApprovalTier,
  resolveApprovalTier,
  type ApprovalTier,
} from '../../src/lib/settings/conversationBehavior';

const APPROVAL_OPTIONS: Array<{
  value: ApprovalTier;
  title: string;
  description: string;
}> = [
  { value: 'ask', title: '每次操作前询问', description: '除安全的只读操作外，执行前先询问。' },
  { value: 'low-risk', title: '自动执行低风险操作', description: '查询和低风险操作自动执行，高风险操作仍需确认。' },
  { value: 'full', title: '尽量自动执行', description: '除系统强制确认的操作外尽量自动执行。' },
];

export default function ChatModelSettingsScreen() {
  const { user, updatePreferences, refreshUser } = useAuth();
  const modelList = useModelList();
  const tts = useTtsPlayer();
  const [saving, setSaving] = useState(false);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const approvalTier = resolveApprovalTier(user?.preferences);
  const debugModeAvailable = user
    ? isDebugModeAvailable(user.tenantId, user.tenantFeatures)
    : false;
  const [debugMode, setDebugMode] = useState(user?.debugMode === true);
  const [debugSaving, setDebugSaving] = useState(false);

  useEffect(() => {
    setDebugMode(user?.debugMode === true && debugModeAvailable);
  }, [debugModeAvailable, user?.debugMode]);

  // 当前默认模型：优先服务端下发的个人偏好，其次 `/api/models` 的 default。
  const selectedModel = useMemo(
    () => user?.preferences?.defaultModel ?? modelList?.default ?? null,
    [modelList?.default, user?.preferences?.defaultModel],
  );

  const handleModelChange = useCallback(
    async (ref: string) => {
      if (saving || ref === selectedModel) return;
      const previous = user?.preferences?.defaultModel;
      setSaving(true);
      updatePreferences({ defaultModel: ref });
      try {
        const saved = await saveUserPreferences({ defaultModel: ref });
        if (!saved) throw new Error('保存失败');
        updatePreferences(saved);
      } catch (error) {
        updatePreferences({ defaultModel: previous });
        Alert.alert('保存失败', error instanceof Error ? error.message : '请稍后重试');
      } finally {
        setSaving(false);
      }
    },
    [saving, selectedModel, updatePreferences, user?.preferences?.defaultModel],
  );

  const handleApprovalChange = useCallback(async (next: ApprovalTier) => {
    if (approvalSaving || next === approvalTier) return;
    const previous = preferencesForApprovalTier(approvalTier);
    const desired = preferencesForApprovalTier(next);
    setApprovalSaving(true);
    updatePreferences(desired);
    try {
      const saved = await saveUserPreferences(desired);
      if (!saved) throw new Error('保存失败');
      updatePreferences(saved);
    } catch (error) {
      updatePreferences(previous);
      Alert.alert('保存失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setApprovalSaving(false);
    }
  }, [approvalSaving, approvalTier, updatePreferences]);

  const handleDebugModeChange = useCallback(async (next: boolean) => {
    if (debugSaving || !debugModeAvailable) return;
    const previous = debugMode;
    setDebugSaving(true);
    setDebugMode(next);
    try {
      const response = await authFetch('/api/auth/me/debug-mode', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugMode: next }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        debugMode?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || '保存失败');
      setDebugMode(payload.debugMode === true);
      void refreshUser();
    } catch (error) {
      setDebugMode(previous);
      Alert.alert('保存失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setDebugSaving(false);
    }
  }, [debugMode, debugModeAvailable, debugSaving, refreshUser]);

  return (
    <SettingsScrollView testID="chat-model-settings-screen" accessibilityLabel="对话与模型">
      <SettingsGroup
        title="模型"
        footnote="仅可选择当前组织允许你使用的模型；已存在会话仍保留各自的模型设置。"
      >
        <ListRow
          title="新建会话默认模型"
          subtitle={saving ? '保存中…' : undefined}
          value={modelList ? undefined : '加载中…'}
          accessory={
            modelList ? (
              <ModelPicker
                testID="default-model-picker"
                accessibilityLabel="新建会话默认模型"
                modelList={modelList}
                selectedModel={selectedModel}
                disabled={saving}
                onModelChange={(ref) => {
                  void handleModelChange(ref);
                }}
              />
            ) : undefined
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="操作前确认"
        footnote="删除、付款、审批等重要操作仍可能要求你再次确认。"
      >
        {APPROVAL_OPTIONS.map((option) => (
          <ListRow
            key={option.value}
            title={option.title}
            subtitle={option.description}
            value={approvalTier === option.value ? '已选择' : undefined}
            onPress={() => { void handleApprovalChange(option.value); }}
            disabled={approvalSaving}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup
        title="执行过程"
        footnote={debugModeAvailable
          ? '开启后显示 Agent 的思考摘要、工具调用和技能执行细节。'
          : '当前组织未开放此功能。'}
      >
        <ListRow
          title="显示详细执行过程"
          switchValue={debugModeAvailable && debugMode}
          switchDisabled={debugSaving || !debugModeAvailable}
          onSwitchChange={(next) => { void handleDebugModeChange(next); }}
        />
      </SettingsGroup>

      <PushNotificationSettings />

      <SettingsGroup
        title="语音"
        footnote={
          tts.available
            ? '开启后新回复自动朗读；本机偏好，不同步到其他设备。'
            : '当前组织未开通语音合成能力。'
        }
      >
        <ListRow
          title="自动播放语音回复"
          switchValue={tts.autoPlay}
          switchDisabled={!tts.available}
          onSwitchChange={tts.toggleAutoPlay}
        />
      </SettingsGroup>
    </SettingsScrollView>
  );
}
