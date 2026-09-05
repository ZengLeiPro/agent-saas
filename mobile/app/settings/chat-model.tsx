/**
 * 对话与模型（`settings/chat-model`）—— 对齐 Web `SettingsModal` 的 `GeneralSection`。
 *
 * 与 Web 同源的项：
 * - 新建会话默认模型：`GET /api/models` + `PATCH /api/auth/me/preferences`
 *   （shared `saveUserPreferences`），选择器直接复用 ChatInput 的 `ModelPicker`，
 *   可选范围与锁组逻辑都走 shared 纯函数，不在设置页另起一套。
 *
 * - 系统推送通知：对应 Web 在本分区挂的 `BrowserNotificationSettings`（浏览器桌面通知），
 *   移动端等价物是 iOS 系统推送（APNs），实现在 `PushNotificationSettings`。
 *
 * 刻意差异：
 * - 系统推送本轮只在 iOS 落地，其余平台整组隐藏，不留点不动的假入口。
 * - 「自动播放语音回复」是移动端独有偏好（本机存储，Web 无对应项），
 *   放在这里给一个持久化入口，与会话顶栏的开关同一份状态。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { saveUserPreferences } from '@agent/shared';
import { useAuth } from '../../src/contexts/AuthContext';
import { useModelList } from '../../src/hooks/useModelList';
import { useTtsPlayer } from '../../src/hooks/useTtsPlayer';
import { ModelPicker } from '../../src/components/chat/ModelPicker';
import { ListRow } from '../../src/components/ui';
import { SettingsGroup, SettingsScrollView } from '../../src/components/settings/SettingsSections';
import { PushNotificationSettings } from '../../src/components/settings/PushNotificationSettings';

export default function ChatModelSettingsScreen() {
  const { user, updatePreferences } = useAuth();
  const modelList = useModelList();
  const tts = useTtsPlayer();
  const [saving, setSaving] = useState(false);

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
