/**
 * 网格布局 —— 对齐 Web `FileBrowser/FileGridItem.tsx`：
 * 大号图标 tile + 两行文件名 + 次要信息，长按（这里用多选模式）可删除。
 * 列数按屏宽自适应，最小卡片宽度与 Web 的 `minmax(96px,1fr)` 同口径。
 */
import React, { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, RefreshControl } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Check } from 'lucide-react-native';
import { formatFileSize, formatShortDate, type FileEntry } from '@agent/shared';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';
import { FileIconTile } from './FileIconTile';

/** 与 Web `minmax(96px,1fr)` 同口径的最小卡片宽度 */
const MIN_TILE_WIDTH = 96;

export interface FileGridProps {
  entries: FileEntry[];
  onRefresh: () => Promise<void>;
  refreshing: boolean;
  onPress: (entry: FileEntry) => void;
  contentPaddingBottom?: number;
  selectMode?: boolean;
  selectedPaths?: Set<string>;
  onSelectToggle?: (path: string) => void;
  /** 容器宽度（用于算列数），由调用方 onLayout 提供 */
  width: number;
}

export function resolveGridColumns(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 3;
  return Math.max(2, Math.floor(width / MIN_TILE_WIDTH));
}

function GridCell({
  entry,
  onPress,
  selectMode,
  selected,
  onSelectToggle,
}: {
  entry: FileEntry;
  onPress: (entry: FileEntry) => void;
  selectMode?: boolean;
  selected?: boolean;
  onSelectToggle?: () => void;
}) {
  const colors = useColors();
  const handlePress = useCallback(() => {
    if (selectMode) {
      onSelectToggle?.();
      return;
    }
    onPress(entry);
  }, [entry, onPress, onSelectToggle, selectMode]);

  const meta = entry.isDirectory ? formatShortDate(entry.modifiedAt) : formatFileSize(entry.size);

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        styles.cell,
        { backgroundColor: pressed ? colors.accent : 'transparent' },
      ]}
      accessibilityRole="button"
      accessibilityLabel={entry.name}
    >
      <View>
        <FileIconTile entry={entry} size="lg" />
        {selectMode ? (
          <View
            style={[
              styles.checkbox,
              { borderColor: colors.mutedForeground, backgroundColor: colors.card },
              selected ? { backgroundColor: colors.primary, borderColor: colors.primary } : null,
            ]}
          >
            {selected ? <Check size={12} color={colors.primaryForeground} strokeWidth={3} /> : null}
          </View>
        ) : null}
      </View>
      <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={2}>
        {entry.name}
      </Text>
      <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
        {meta}
      </Text>
    </Pressable>
  );
}

export function FileGrid({
  entries,
  onRefresh,
  refreshing,
  onPress,
  contentPaddingBottom = 0,
  selectMode,
  selectedPaths,
  onSelectToggle,
  width,
}: FileGridProps) {
  const colors = useColors();
  const columns = resolveGridColumns(width);

  const contentContainerStyle = useMemo(
    () => ({ paddingBottom: contentPaddingBottom + spacing.xl, paddingHorizontal: spacing.sm }),
    [contentPaddingBottom],
  );

  return (
    <FlashList
      key={`grid-${columns}-${selectMode ? 'select' : 'browse'}`}
      data={entries}
      numColumns={columns}
      keyExtractor={(item) => item.path}
      renderItem={({ item }) => (
        <GridCell
          entry={item}
          onPress={onPress}
          selectMode={selectMode}
          selected={selectedPaths?.has(item.path)}
          onSelectToggle={onSelectToggle ? () => onSelectToggle(item.path) : undefined}
        />
      )}
      contentContainerStyle={contentContainerStyle}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    />
  );
}

const styles = StyleSheet.create({
  cell: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.lg,
  },
  checkbox: {
    position: 'absolute',
    right: -spacing.xs,
    top: -spacing.xs,
    width: 18,
    height: 18,
    borderRadius: radius.full,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    ...fontScale.xs,
    fontWeight: fontWeight.medium,
    textAlign: 'center',
  },
  meta: {
    ...fontScale.xs2,
    textAlign: 'center',
  },
});
