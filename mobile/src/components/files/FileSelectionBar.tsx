/**
 * 多选模式底部操作条 —— 只保留「删除」一个动作。
 *
 * 之前的「移动」是「正在开发中」占位；文件中心进入 V1 生产 allowlist 后
 * 不允许留占位文案（见 v1RouteInventory 的占位扫描），故一并去掉。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';

export interface FileSelectionBarProps {
  selectedCount: number;
  onDelete: () => void;
  bottomInset: number;
  testID?: string;
}

export function FileSelectionBar({
  selectedCount,
  onDelete,
  bottomInset,
  testID,
}: FileSelectionBarProps) {
  const colors = useColors();
  const disabled = selectedCount === 0;

  return (
    <View style={[styles.bar, { bottom: bottomInset + spacing.sm }]} pointerEvents="box-none">
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`删除选中的 ${selectedCount} 项`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onDelete}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: colors.muted,
            opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
          },
        ]}
      >
        <Trash2
          size={20}
          color={disabled ? colors.mutedForeground : colors.destructive}
          strokeWidth={2}
        />
        <Text
          style={[styles.label, { color: disabled ? colors.mutedForeground : colors.destructive }]}
        >
          删除{selectedCount > 0 ? ` (${selectedCount})` : ''}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
    zIndex: 100,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 50,
    paddingHorizontal: spacing['2xl'],
    borderRadius: radius.full,
  },
  label: {
    ...fontScale.base,
    fontWeight: fontWeight.semibold,
  },
});
