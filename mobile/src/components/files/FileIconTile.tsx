/**
 * 文件类型图标 tile —— 对齐 Web `FileBrowser/fileIcons.tsx` 的 `FileIconTile`：
 * 「浅底圆角方块 + 同色相图标」，类别与色板全部来自 shared（见 fileVisual.ts）。
 * Web 的浅底用 Tailwind 色阶，RN 没有 alpha 变体，这里统一用主题 `muted` 作底，
 * 只让图标吃类别色，保证深浅色都够对比。
 */
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { FileTypeIcons } from '../../lib/icons';
import { useColors, useTheme, radius } from '../../theme';
import { resolveFileVisual, type FileVisualEntry } from './fileVisual';

export type FileIconTileSize = 'sm' | 'lg';

const TILE = {
  sm: { box: 36, icon: 18, corner: radius.lg },
  lg: { box: 56, icon: 28, corner: radius.xl },
} as const;

export interface FileIconTileProps {
  entry: FileVisualEntry;
  /** 列表用 sm，网格用 lg */
  size?: FileIconTileSize;
}

export function FileIconTile({ entry, size = 'sm' }: FileIconTileProps) {
  const colors = useColors();
  const { isDark } = useTheme();
  const visual = resolveFileVisual(entry, isDark);
  const Icon = FileTypeIcons[visual.category];
  const dims = TILE[size];

  const tileStyle = useMemo(
    () => [
      styles.tile,
      {
        width: dims.box,
        height: dims.box,
        borderRadius: dims.corner,
        backgroundColor: colors.muted,
      },
    ],
    [colors.muted, dims],
  );

  return (
    <View style={tileStyle}>
      <Icon size={dims.icon} color={visual.color ?? colors.brand[600]} strokeWidth={2} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
