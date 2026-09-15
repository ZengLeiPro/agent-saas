/**
 * Temporary left chrome when master list is hidden by protection / collapse.
 * Mirrors web responsive sidebar reveal (hamburger → overlay list).
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors } from '../../theme';
import { MASTER_LIST_WIDTH } from '../../lib/layoutDensity';

export type MasterListOverlayProps = {
  visible: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
  width?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function MasterListOverlay({
  visible,
  onDismiss,
  children,
  width = MASTER_LIST_WIDTH,
  testID = 'master-list-overlay',
  style,
}: MasterListOverlayProps) {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: {
          ...StyleSheet.absoluteFillObject,
          zIndex: 50,
          flexDirection: 'row',
          justifyContent: 'flex-start',
        },
        dimmer: {
          ...StyleSheet.absoluteFillObject,
          backgroundColor: 'rgba(0,0,0,0.28)',
        },
        panel: {
          width,
          maxWidth: '88%',
          height: '100%',
          backgroundColor: colors.card,
          borderRightWidth: StyleSheet.hairlineWidth,
          borderRightColor: colors.border,
          shadowColor: colors.shadow,
          shadowOffset: { width: 2, height: 0 },
          shadowOpacity: 0.12,
          shadowRadius: 8,
          elevation: 8,
        },
      }),
    [colors, width],
  );

  if (!visible) return null;

  return (
    <View style={[styles.root, style]} testID={testID} pointerEvents="box-none">
      <Pressable
        style={styles.dimmer}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="关闭列表"
        testID={`${testID}-dimmer`}
      />
      <View style={styles.panel}>{children}</View>
    </View>
  );
}
