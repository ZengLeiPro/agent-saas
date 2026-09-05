/**
 * 会话列表右下角悬浮按钮 —— 对齐 Web `MobileNewSessionActions`。
 *
 * 主按钮：48pt 品牌蓝圆形「新建会话」；
 * 次按钮：存在手动分组时，主按钮上方再叠一枚 `FolderPlus`「新建分组」。
 * 两者的底部定位都叠加 safe-area-inset-bottom。
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FolderPlus, Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hapticLight } from '../../lib/haptics';
import { useColors, radius, shadows, spacing } from '../../theme';

/** 主 FAB 直径（pt），对齐 Web `size-12` */
const FAB_SIZE = 48;
/** 次级 FAB 直径（pt），对齐 Web `size-10` */
const SECONDARY_FAB_SIZE = 40;
const PRESSED_OPACITY = 0.8;

export interface SessionListFabsProps {
  /** 是否存在手动分组：决定次级「新建分组」FAB 是否出现 */
  hasManualGroups: boolean;
  disabled?: boolean;
  onNewSession: () => void;
  onNewGroup: () => void;
}

export function SessionListFabs({
  hasManualGroups,
  disabled = false,
  onNewSession,
  onNewGroup,
}: SessionListFabsProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          position: 'absolute',
          right: spacing.lg,
          bottom: insets.bottom + spacing.lg,
          alignItems: 'center',
          gap: spacing.sm,
        },
        fab: {
          width: FAB_SIZE,
          height: FAB_SIZE,
          borderRadius: radius.full,
          backgroundColor: colors.primary,
          alignItems: 'center',
          justifyContent: 'center',
          ...shadows.brand,
        },
        secondaryFab: {
          width: SECONDARY_FAB_SIZE,
          height: SECONDARY_FAB_SIZE,
          borderRadius: radius.full,
          backgroundColor: colors.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          alignItems: 'center',
          justifyContent: 'center',
          ...shadows.card,
        },
        pressed: {
          opacity: PRESSED_OPACITY,
        },
        disabled: {
          opacity: 0.5,
        },
      }),
    [colors, insets.bottom],
  );

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {hasManualGroups && (
        <Pressable
          testID="new-session-group-fab"
          accessibilityRole="button"
          accessibilityLabel="新建分组"
          disabled={disabled}
          onPress={() => {
            hapticLight();
            onNewGroup();
          }}
          style={({ pressed }) => [
            styles.secondaryFab,
            pressed && styles.pressed,
            disabled && styles.disabled,
          ]}
        >
          <FolderPlus size={20} color={colors.mutedForeground} strokeWidth={2} />
        </Pressable>
      )}
      <Pressable
        testID="new-session-fab"
        accessibilityRole="button"
        accessibilityLabel="新建会话"
        disabled={disabled}
        onPress={() => {
          hapticLight();
          onNewSession();
        }}
        style={({ pressed }) => [
          styles.fab,
          pressed && styles.pressed,
          disabled && styles.disabled,
        ]}
      >
        <Plus size={24} color={colors.primaryForeground} strokeWidth={2} />
      </Pressable>
    </View>
  );
}
