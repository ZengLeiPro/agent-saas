/**
 * 外观与布局（`settings/appearance-layout`）—— 对齐 Web
 * `SettingsCenter/AppearanceLayoutPreferences.tsx` 的三项，逐项说明取舍：
 *
 * 1. 会话字体大小：Web 二档（小 14px / 大 16px）。移动端保留三档
 *    （小 / 默认 / 大），`默认` 是移动端独有的出厂档；档位常量与
 *    Web 互转在 `src/lib/settings/chatFontSize.ts`。
 * 2. 桌面侧边栏样式（双栏 / 单栏）：宽屏（md+）会话 chrome **默认单栏**
 *    （列表|详情 master-detail，无 Web 双栏二级侧栏）；不提供切换开关。
 * 3. 会话列表显示头像：移动端**永远显示**（含 iPad），不提供开关，也不读
 *    Web 共享偏好 `showSessionListAvatar`——分组行固定带图标，个人会话若
 *    跟随 Web 偏好隐藏头像会与分组行错位；该偏好仅继续影响 Web 端。
 *
 * 另：主题跟随系统，移动端与 Web 都没有手动切换器，这里只做只读说明。
 */
import React from 'react';
import { View } from 'react-native';
import { Chip, ListRow } from '../../src/components/ui';
import { SettingsGroup, SettingsScrollView } from '../../src/components/settings/SettingsSections';
import { CHAT_FONT_SIZE_LABELS, CHAT_FONT_SIZE_LEVELS } from '../../src/lib/settings/chatFontSize';
import { spacing, useFontSize, useTheme, useThemedStyles } from '../../src/theme';

export default function AppearanceLayoutSettingsScreen() {
  const { level, setLevel } = useFontSize();
  const { isDark } = useTheme();

  const styles = useThemedStyles(() => ({
    fontSizeOptions: { flexDirection: 'row' as const, gap: spacing.xs },
  }));

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
        title="宽屏布局"
        footnote="iPad / 宽屏（窗口宽度 ≥ 768）采用左侧导航 chrome 与会话列表|详情并排；默认单栏会话 chrome，会话列表始终显示头像。业务系统/apps 不进入移动导航。"
      >
        <ListRow title="会话 chrome" value="单栏（默认）" />
        <ListRow title="会话列表头像" value="始终显示" />
      </SettingsGroup>
    </SettingsScrollView>
  );
}
