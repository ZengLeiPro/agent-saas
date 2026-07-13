import React, { useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  Pressable,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Check, Folder, Image, FileText, FileCode, File, type LucideIcon } from 'lucide-react-native';
import { formatFileSize, formatShortDate } from '@agent/shared';
import type { FileEntry } from '@agent/shared';
import { SwipeableRow, type SwipeAction, type Swipeable } from '../SwipeableRow';
import { SkeletonList } from '../SkeletonList';
import { useColors, spacing, typography, type ThemeColors } from '../../theme';

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

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const TEXT_EXTS = new Set(['.md', '.txt', '.html', '.htm', '.csv', '.log']);
const CODE_EXTS = new Set(['.json', '.js', '.ts', '.jsx', '.tsx', '.css', '.py', '.sh']);

function getIconInfo(entry: FileEntry, colors: ThemeColors): { Icon: LucideIcon; color: string } {
  if (entry.isDirectory) return { Icon: Folder, color: colors.statusIcon.info };
  if (IMAGE_EXTS.has(entry.extension)) return { Icon: Image, color: colors.statusIcon.success };
  if (TEXT_EXTS.has(entry.extension)) return { Icon: FileText, color: colors.statusIcon.purple };
  if (CODE_EXTS.has(entry.extension)) return { Icon: FileCode, color: colors.link };
  return { Icon: File, color: colors.mutedForeground };
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
  const icon = getIconInfo(entry, colors);
  const parentFolder = showPath ? getParentFolder(entry.path) : '';

  const rightText = showPath && parentFolder
    ? `${parentFolder}/`
    : entry.isDirectory
      ? formatShortDate(entry.modifiedAt)
      : `${formatFileSize(entry.size)} · ${formatShortDate(entry.modifiedAt)}`;

  const separatorLeft = spacing.sm + (selectMode ? 24 + spacing.sm : 0) + 24 + spacing.md;

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
        <icon.Icon size={20} color={icon.color} strokeWidth={2} />
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

  if (loading && entries.length === 0) {
    return <SkeletonList />;
  }

  if (!loading && entries.length === 0) {
    return (
      <View style={[styles.center, { flex: 1, backgroundColor: colors.card }]}>
        <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>暂无文件</Text>
      </View>
    );
  }

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

const styles = StyleSheet.create({
  swipeContainer: {
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
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
    width: 24,
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
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    ...typography.body,
  },
});
