/**
 * 能力中心顶部四 Tab —— 对齐 Web `CapabilityTabsList`（segmented 分段控件）。
 *
 * 原生端用 `ui/Chip` 拼 segmented 行：选中态品牌实底、未选中 hairline 胶囊，
 * 与会话列表顶部 pill 行同一套视觉语言。Tab 切换走 `router.replace`，
 * 保证返回键不会在四个 Tab 之间来回弹。
 */
import React, { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Chip } from '../ui';
import { spacing } from '../../theme';
import { capabilityTabsFor, type CapabilityTab } from '../../lib/capabilities/capabilityTabs';

export interface CapabilityTabBarProps {
  active: CapabilityTab;
  personalAgentEnabled: boolean;
}

export function CapabilityTabBar({ active, personalAgentEnabled }: CapabilityTabBarProps) {
  const router = useRouter();
  const tabs = useMemo(() => capabilityTabsFor(personalAgentEnabled), [personalAgentEnabled]);

  const go = useCallback(
    (route: string) => {
      router.replace(route as never);
    },
    [router],
  );

  return (
    <View style={styles.wrap} testID="capability-tab-bar">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.row}>
          {tabs.map((tab) => (
            <Chip
              key={tab.value}
              label={tab.label}
              selected={tab.value === active}
              onPress={() => go(tab.route)}
              testID={`capability-tab-${tab.value}`}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
