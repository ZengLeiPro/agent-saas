/**
 * Single right-slot panel (web DesktopLayout right pane concept).
 * - overlay: absolute over the host with optional dimmer (md+ when dock is tight)
 * - docked: flex sibling beside main with a left divider (lg+ when budget allows)
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, fontScale, fontWeight, spacing } from '../../theme';
import { RIGHT_OVERLAY_WIDTH } from '../../lib/layoutDensity';

export type SideOverlayPresentation = 'overlay' | 'docked';

export type SideOverlayPanelProps = {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /** Dim the host behind the panel (overlay only; default true). */
  dimmed?: boolean;
  /** overlay = absolute; docked = in-flow column beside main. */
  presentation?: SideOverlayPresentation;
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
  presentation = 'overlay',
}: SideOverlayPanelProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const docked = presentation === 'docked';
  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: docked
          ? {
              width,
              flexShrink: 0,
              height: '100%',
              zIndex: 20,
            }
          : {
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
          width: docked ? '100%' : width,
          maxWidth: docked ? undefined : '92%',
          height: '100%',
          backgroundColor: colors.background,
          borderLeftWidth: StyleSheet.hairlineWidth,
          borderLeftColor: colors.border,
          ...(docked
            ? {}
            : {
                shadowColor: colors.shadow,
                shadowOffset: { width: -2, height: 0 },
                shadowOpacity: 0.12,
                shadowRadius: 8,
                elevation: 8,
              }),
        },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          paddingTop: docked ? spacing.sm : Math.max(insets.top, spacing.sm),
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
    [colors, insets.top, width, docked],
  );

  return (
    <View
      style={[styles.root, style]}
      testID={testID}
      accessibilityHint={docked ? 'docked-right-pane' : 'overlay-right-pane'}
      pointerEvents="box-none"
    >
      {!docked && dimmed ? (
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
