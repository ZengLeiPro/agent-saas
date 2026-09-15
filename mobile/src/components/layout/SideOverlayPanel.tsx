/**
 * Single right-slot overlay (web DesktopLayout right pane concept).
 * Absolute over the host; used on md+ instead of full-screen push/Modal.
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, fontScale, fontWeight, spacing } from '../../theme';
import { RIGHT_OVERLAY_WIDTH } from '../../lib/layoutDensity';

export type SideOverlayPanelProps = {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /** Dim the host behind the panel (default true). */
  dimmed?: boolean;
};

export function SideOverlayPanel({
  title,
  subtitle,
  onClose,
  children,
  width = RIGHT_OVERLAY_WIDTH,
  testID = 'side-overlay-panel',
  style,
  dimmed = true,
}: SideOverlayPanelProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: {
          ...StyleSheet.absoluteFillObject,
          zIndex: 40,
          flexDirection: 'row',
          justifyContent: 'flex-end',
        },
        dimmer: {
          ...StyleSheet.absoluteFillObject,
          backgroundColor: 'rgba(0,0,0,0.28)',
        },
        panel: {
          width,
          maxWidth: '92%',
          height: '100%',
          backgroundColor: colors.background,
          borderLeftWidth: StyleSheet.hairlineWidth,
          borderLeftColor: colors.border,
          shadowColor: colors.shadow,
          shadowOffset: { width: -2, height: 0 },
          shadowOpacity: 0.12,
          shadowRadius: 8,
          elevation: 8,
        },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          paddingTop: Math.max(insets.top, spacing.sm),
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          backgroundColor: colors.background,
        },
        headerText: { flex: 1, minWidth: 0 },
        title: { ...fontScale.base, fontWeight: fontWeight.semibold, color: colors.foreground },
        subtitle: { ...fontScale.xs, color: colors.mutedForeground, marginTop: 2 },
        close: { padding: spacing.xs },
        body: { flex: 1 },
      }),
    [colors, insets.top, width],
  );

  return (
    <View style={[styles.root, style]} testID={testID} pointerEvents="box-none">
      {dimmed ? (
        <Pressable
          style={styles.dimmer}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="关闭面板"
        />
      ) : null}
      <View style={styles.panel}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={styles.close}
            accessibilityRole="button"
            accessibilityLabel="关闭"
            testID={`${testID}-close`}
          >
            <X size={22} color={colors.foreground} strokeWidth={2} />
          </Pressable>
        </View>
        <View style={styles.body}>{children}</View>
      </View>
    </View>
  );
}
