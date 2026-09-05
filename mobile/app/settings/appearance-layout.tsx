/**
 * 外观与布局（`settings/appearance-layout`）—— 对齐 Web
 * `SettingsCenter/AppearanceLayoutPreferences.tsx` 的三项，逐项说明取舍：
 *
 * 1. 会话字体大小：Web 二档（小 14px / 大 16px）。移动端保留三档
 *    （小 / 默认 / 大），`默认` 是移动端独有的出厂档；档位常量与
 *    Web 互转在 `src/lib/settings/chatFontSize.ts`。
 * 2. 桌面侧边栏样式（双栏 / 单栏）：移动端没有侧边栏概念，**不做**。
 * 3. 会话列表显示头像：做，走同一份服务端偏好 `showSessionListAvatar`；
 *    默认值刻意与 Web 不同——Web 缺省为「不显示」，移动端缺省为「显示」
 *    （会话列表本来就是头像主导的紧凑布局，缺省关掉会是回退）。
 *
 * 另：主题跟随系统，移动端与 Web 都没有手动切换器，这里只做只读说明。
 */
import React, { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { saveUserPreferences } from '@agent/shared';
import { useAuth } from '../../src/contexts/AuthContext';
import { Chip, ListRow } from '../../src/components/ui';
import { SettingsGroup, SettingsScrollView } from '../../src/components/settings/SettingsSections';
import { CHAT_FONT_SIZE_LABELS, CHAT_FONT_SIZE_LEVELS } from '../../src/lib/settings/chatFontSize';
import { spacing, useFontSize, useTheme, useThemedStyles } from '../../src/theme';

export default function AppearanceLayoutSettingsScreen() {
  const { user, updatePreferences } = useAuth();
  const { level, setLevel } = useFontSize();
  const { isDark } = useTheme();
  const [avatarSaving, setAvatarSaving] = useState(false);

  // 缺省显示头像（与 Web 缺省相反，见文件头说明）。
  const showSessionListAvatar = user?.preferences?.showSessionListAvatar !== false;

  const styles = useThemedStyles(() => ({
    fontSizeOptions: { flexDirection: 'row' as const, gap: spacing.xs },
  }));

  const handleAvatarPrefChange = useCallback(
    async (next: boolean) => {
      setAvatarSaving(true);
      updatePreferences({ showSessionListAvatar: next });
      try {
        const saved = await saveUserPreferences({ showSessionListAvatar: next });
        if (!saved) throw new Error('保存失败');
        updatePreferences(saved);
      } catch (error) {
        updatePreferences({ showSessionListAvatar });
        Alert.alert('保存失败', error instanceof Error ? error.message : '请稍后重试');
      } finally {
        setAvatarSaving(false);
      }
    },
    [showSessionListAvatar, updatePreferences],
  );

  return (
    <SettingsScrollView testID="appearance-settings-screen" accessibilityLabel="外观与布局">
      <SettingsGroup
        title="显示"
        footnote="字体大小只影响会话正文；「默认」是移动端独有档位，Web 端会按「小」处理。"
      >
        <ListRow
          title="字体大小"
          accessory={
            <View style={styles.fontSizeOptions}>
              {CHAT_FONT_SIZE_LEVELS.map((option) => (
                <Chip
                  key={option}
                  label={CHAT_FONT_SIZE_LABELS[option]}
                  selected={level === option}
                  onPress={() => setLevel(option)}
                />
              ))}
            </View>
          }
        />
        <ListRow
          title="主题"
          subtitle="跟随系统深色模式，暂不提供手动切换"
          value={isDark ? '深色（跟随系统）' : '浅色（跟随系统）'}
        />
      </SettingsGroup>

      <SettingsGroup
        title="会话列表"
        footnote="关闭后会话列表使用更紧凑的单行样式；该偏好与 Web 端共用。移动端不提供桌面侧边栏布局设置。"
      >
        <ListRow
          title="显示 Agent 头像"
          switchValue={showSessionListAvatar}
          switchDisabled={avatarSaving}
          onSwitchChange={(next) => {
            void handleAvatarPrefChange(next);
          }}
        />
      </SettingsGroup>
    </SettingsScrollView>
  );
}
