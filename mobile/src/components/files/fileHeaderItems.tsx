/**
 * 文件中心头部按钮 —— `/files` 与 `/files/browse` 共用，
 * 避免两条路由各写一遍 `headerLeft` / `unstable_headerLeftItems` 的双份 JSX。
 */
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { MoreHorizontal } from 'lucide-react-native';
import { useColors, fontScale } from '../../theme';

export interface HeaderTextButtonProps {
  label: string;
  onPress: () => void;
  testID?: string;
}

/** 头部纯文字按钮（选择 / 完成 / 全选） */
export function HeaderTextButton({ label, onPress, testID }: HeaderTextButtonProps) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
    >
      <Text style={[styles.text, { color: colors.foreground }]}>{label}</Text>
    </Pressable>
  );
}

export interface HeaderMenuButtonProps {
  onPress: () => void;
  triggerRef: React.RefObject<React.ComponentRef<typeof Pressable> | null>;
  testID?: string;
}

/** 头部「…」下拉触发器 */
export function HeaderMenuButton({ onPress, triggerRef, testID }: HeaderMenuButtonProps) {
  const colors = useColors();
  return (
    <Pressable
      ref={triggerRef}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="更多"
      onPress={onPress}
      hitSlop={8}
    >
      <MoreHorizontal size={22} color={colors.foreground} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  text: {
    ...fontScale.base,
  },
});
