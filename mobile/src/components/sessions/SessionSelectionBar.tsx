/**
 * 多选模式底部胶囊条（原生独有能力：批量分组 / 批量删除）。
 * 从 `(tabs)/chat/index.tsx` 抽出，行为不变。
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hapticLight } from '../../lib/haptics';
import { useColors, radius, spacing, fontScale, fontWeight } from '../../theme';

const PILL_HEIGHT = 50;

export interface SessionSelectionBarProps {
  selectedCount: number;
  /** 只读分组视图下禁用批量分组 */
  canGroup: boolean;
  onGroup: () => void;
  onDelete: () => void;
}

export function SessionSelectionBar({
  selectedCount,
  canGroup,
  onGroup,
  onDelete,
}: SessionSelectionBarProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const hasSelection = selectedCount > 0;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          position: 'absolute',
          bottom: insets.bottom + spacing.sm,
          left: spacing.lg,
          right: spacing.lg,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          zIndex: 100,
        },
        pill: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          height: PILL_HEIGHT,
          paddingHorizontal: spacing.xl,
          borderRadius: radius.full,
          backgroundColor: colors.muted,
        },
        iconPill: {
          width: PILL_HEIGHT,
          height: PILL_HEIGHT,
          borderRadius: radius.full,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.muted,
        },
        pillText: {
          ...fontScale.base,
          fontWeight: fontWeight.semibold,
          color: colors.foreground,
        },
      }),
    [colors, insets.bottom],
  );

  const label = `分组${hasSelection ? ` (${selectedCount})` : ''}`;
  const groupPill = (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {hasSelection && canGroup ? (
        <Pressable
          testID="session-batch-group"
          onPress={() => {
            hapticLight();
            onGroup();
          }}
        >
          {groupPill}
        </Pressable>
      ) : (
        groupPill
      )}
      <TouchableOpacity
        testID="session-batch-delete"
        onPress={onDelete}
        disabled={!hasSelection}
        activeOpacity={0.7}
      >
        <View style={styles.iconPill}>
          <Trash2
            size={24}
            color={hasSelection ? colors.destructive : colors.foreground}
            strokeWidth={2}
          />
        </View>
      </TouchableOpacity>
    </View>
  );
}
