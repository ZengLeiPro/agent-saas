/**
 * 设置页分组容器：分组标题 + `ListRowGroup` + 可选脚注。
 * 设置主页与 8 个分区详情页共用，避免各页重复写标题样式。
 */
import React from 'react';
import { Text, View } from 'react-native';
import { fontScale, fontWeight, spacing, useThemedStyles } from '../../../theme';
import { ListRowGroup } from '../../ui/ListRow';

export interface SettingsGroupProps {
  /** 分组标题；不传则只渲染卡片（用于单卡片无标题场景） */
  title?: string;
  /** 卡片下方的说明文字（对齐 iOS 设置的 footer note） */
  footnote?: string;
  children?: React.ReactNode;
  testID?: string;
}

export function SettingsGroup({ title, footnote, children, testID }: SettingsGroupProps) {
  const styles = useThemedStyles((colors) => ({
    section: { marginBottom: spacing.xl },
    title: {
      ...fontScale.xs,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
      textTransform: 'uppercase' as const,
      marginBottom: spacing.sm,
      marginLeft: spacing.xs,
    },
    footnote: {
      ...fontScale.xs,
      color: colors.mutedForeground,
      marginTop: spacing.sm,
      marginHorizontal: spacing.xs,
    },
  }));

  return (
    <View style={styles.section} testID={testID}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <ListRowGroup>{children}</ListRowGroup>
      {footnote ? <Text style={styles.footnote}>{footnote}</Text> : null}
    </View>
  );
}
