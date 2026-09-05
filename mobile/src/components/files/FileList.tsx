import React, { useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  Pressable,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Check } from 'lucide-react-native';
import { formatFileSize, formatShortDate } from '@agent/shared';
import type { FileEntry } from '@agent/shared';
import { SwipeableRow, type SwipeAction, type Swipeable } from '../SwipeableRow';
import { useColors, spacing, typography, type ThemeColors } from '../../theme';
import { FileIconTile } from './FileIconTile';

interface FileListProps {
  entries: FileEntry[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onPress: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  contentPaddingBottom?: number;
  showPath?: boolean;
  enableBackGesture?: boolean;
  /** Multi-select mode */
  selectMode?: boolean;
  selectedPaths?: Set<string>;
  onSelectToggle?: (path: string) => void;
}

function getParentFolder(path: string): string {
  const parts = path.split('/');
  return parts.length > 2 ? parts.slice(1, -1).join('/') : '';
}

function FileRow({ entry, onPress, onDelete, openRowRef, colors, showPath, enableBackGesture, selectMode, selected, onSelectToggle }: {
  entry: FileEntry;
  onPress: (e: FileEntry) => void;
  onDelete?: (e: FileEntry) => void;
  openRowRef: React.MutableRefObject<Swipeable | null>;
  colors: ThemeColors;
  showPath?: boolean;
  enableBackGesture?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onSelectToggle?: () => void;
}) {
  const parentFolder = showPath ? getParentFolder(entry.path) : '';

  const rightText = showPath && parentFolder
    ? `${parentFolder}/`
    : entry.isDirectory
      ? formatShortDate(entry.modifiedAt)
      : `${formatFileSize(entry.size)} · ${formatShortDate(entry.modifiedAt)}`;

  const separatorLeft = spacing.md + (selectMode ? 24 + spacing.sm : 0) + ICON_TILE_PX + spacing.md;

  const actions: SwipeAction[] = useMemo(() => {
    if (!onDelete) return [];
    return [{
      key: 'delete',
      label: '删除',
      backgroundColor: colors.destructive,
      color: colors.destructiveForeground,
      onPress: () => onDelete(entry),
    }];
  }, [onDelete, entry, colors]);

  const handlePress = useCallback(() => {
    if (selectMode) {
      onSelectToggle?.();
      return;
    }
    if (openRowRef.current) {
      openRowRef.current.close();
      return;
    }
    onPress(entry);
  }, [onPress, entry, openRowRef, selectMode, onSelectToggle]);

  const content = (
    <Pressable
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.accent : colors.card }]}
      onPress={handlePress}
    >
      {selectMode && (
        <View style={[styles.checkbox, { borderColor: colors.mutedForeground }, selected && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
          {selected && <Check size={16} color={colors.primaryForeground} strokeWidth={2.5} />}
        </View>
      )}
      <View style={styles.iconContainer}>
        <FileIconTile entry={entry} size="sm" />
      </View>
      <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
        {entry.name}
      </Text>
      <Text style={[styles.rightText, { color: colors.mutedForeground }]} numberOfLines={1}>
        {rightText}
      </Text>
      <View style={[styles.separator, { left: separatorLeft, backgroundColor: colors.border }]} />
    </Pressable>
  );

  if (selectMode || actions.length === 0) return content;

  return (
    <SwipeableRow
      actions={actions}
      openRowRef={openRowRef}
      containerStyle={styles.swipeContainer}
      enableBackGesture={enableBackGesture}
    >
      {content}
    </SwipeableRow>
  );
}

export function FileList({ entries, loading, onRefresh, onPress, onDelete, contentPaddingBottom = 0, showPath, enableBackGesture, selectMode, selectedPaths, onSelectToggle }: FileListProps) {
  const colors = useColors();
  const openRowRef = useRef<Swipeable | null>(null);

  const listStyles = useMemo(() => ({
    contentContainer: {
      paddingBottom: contentPaddingBottom + spacing.xl,
    },
  }), [contentPaddingBottom]);

  // 骨架 / 空态由 `FileBrowserBody` 统一owner（与 Web FileBrowser 一致），
  // 这里只负责列表本体。
  return (
    <FlashList
      key={selectMode ? 'select' : 'list'}
      data={entries}
      keyExtractor={(item) => item.path}
      renderItem={({ item }) => (
        <FileRow
          entry={item}
          onPress={onPress}
          onDelete={onDelete}
          openRowRef={openRowRef}
          colors={colors}
          showPath={showPath}
          enableBackGesture={!selectMode && enableBackGesture}
          selectMode={selectMode}
          selected={selectedPaths?.has(item.path)}
          onSelectToggle={onSelectToggle ? () => onSelectToggle(item.path) : undefined}
        />
      )}
      drawDistance={250}
      contentContainerStyle={listStyles.contentContainer}
      onScrollBeginDrag={() => openRowRef.current?.close()}
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
    />
  );
}

/** 与 FileIconTile size="sm" 的 tile 尺寸保持一致（分隔线缩进要对齐） */
const ICON_TILE_PX = 36;

const styles = StyleSheet.create({
  swipeContainer: {
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.sm,
  },
  iconContainer: {
    width: ICON_TILE_PX,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  name: {
    ...typography.body,
    fontWeight: '500',
    flex: 1,
    marginRight: spacing.sm,
  },
  rightText: {
    ...typography.caption,
    flexShrink: 0,
  },
  separator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
});
