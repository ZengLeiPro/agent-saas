/** 设置类页面的统一滚动容器（背景、内边距、底部安全区；md+ 居中限宽）。 */
import React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing, useThemedStyles } from '../../../theme';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { formContentMaxWidthStyle } from '../../../lib/layoutDensity';

export interface SettingsScrollViewProps {
  children?: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  /** When false, skip md+ FORM maxWidth (e.g. settings master list in split). Default true. */
  constrainWidth?: boolean;
}

export function SettingsScrollView({
  children,
  refreshing,
  onRefresh,
  testID,
  accessibilityLabel,
  constrainWidth = true,
}: SettingsScrollViewProps) {
  const insets = useSafeAreaInsets();
  const { isMdUp } = useBreakpoint();
  const styles = useThemedStyles((colors) => ({
    container: { flex: 1, backgroundColor: colors.background },
    content: {
      paddingTop: spacing.lg,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.lg + insets.bottom,
    },
  }));

  const widthStyle = constrainWidth ? formContentMaxWidthStyle(isMdUp) : { width: '100%' as const };

  return (
    <View style={styles.container} testID={testID} accessibilityLabel={accessibilityLabel}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, widthStyle]}
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
