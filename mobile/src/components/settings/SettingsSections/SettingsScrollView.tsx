/** 设置类页面的统一滚动容器（背景、内边距、底部安全区）。 */
import React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing, useThemedStyles } from '../../../theme';

export interface SettingsScrollViewProps {
  children?: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}

export function SettingsScrollView({
  children,
  refreshing,
  onRefresh,
  testID,
  accessibilityLabel,
}: SettingsScrollViewProps) {
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles((colors) => ({
    container: { flex: 1, backgroundColor: colors.background },
    content: {
      paddingTop: spacing.lg,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.lg + insets.bottom,
    },
  }));

  return (
    <View style={styles.container} testID={testID} accessibilityLabel={accessibilityLabel}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}
