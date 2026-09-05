/**
 * 文件浏览主体 —— 对齐 Web `FileBrowser` 的「骨架 / 空态 / 列表 / 网格」四态切换，
 * 让 `/files` 与 `/files/browse` 两条路由共用同一套呈现层（差别只在头部与取数）。
 */
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import type { FileEntry } from '@agent/shared';
import { EmptyState, Skeleton } from '../ui';
import { EntityIcons } from '../../lib/icons';
import { useColors, spacing, radius } from '../../theme';
import { FileList } from './FileList';
import { FileGrid } from './FileGrid';

export type FileLayoutMode = 'list' | 'grid';

export interface FileBrowserBodyProps {
  entries: FileEntry[];
  loading: boolean;
  loadingMore?: boolean;
  error?: string | null;
  hasMore?: boolean;
  onLoadMore?: () => Promise<void>;
  layoutMode: FileLayoutMode;
  onRefresh: () => Promise<void>;
  onPress: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  contentPaddingBottom?: number;
  showPath?: boolean;
  enableBackGesture?: boolean;
  selectMode?: boolean;
  selectedPaths?: Set<string>;
  onSelectToggle?: (path: string) => void;
  /** 空态文案：所有文件视图与文件夹视图措辞不同（与 Web EmptyState 一致） */
  emptyVariant?: 'folder' | 'all';
}

/** 骨架屏：与列表行等高，避免加载完成时的视觉跳动 */
function FileListSkeleton({ layoutMode }: { layoutMode: FileLayoutMode }) {
  const colors = useColors();
  if (layoutMode === 'grid') {
    return (
      <View style={[styles.skeletonGrid, { backgroundColor: colors.card }]} testID="file-skeleton">
        {Array.from({ length: 12 }, (_, index) => (
          <View key={index} style={styles.skeletonCell}>
            <Skeleton width={56} height={56} borderRadius={radius.xl} />
            <Skeleton width="70%" height={10} />
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={[styles.skeletonList, { backgroundColor: colors.card }]} testID="file-skeleton">
      {Array.from({ length: 10 }, (_, index) => (
        <View key={index} style={styles.skeletonRow}>
          <Skeleton width={36} height={36} borderRadius={radius.lg} />
          <View style={styles.skeletonRowText}>
            <Skeleton width="55%" height={12} />
          </View>
          <Skeleton width={56} height={10} />
        </View>
      ))}
    </View>
  );
}

export function FileBrowserBody({
  entries,
  loading,
  loadingMore,
  error,
  hasMore,
  onLoadMore,
  layoutMode,
  onRefresh,
  onPress,
  onDelete,
  contentPaddingBottom = 0,
  showPath,
  enableBackGesture,
  selectMode,
  selectedPaths,
  onSelectToggle,
  emptyVariant = 'folder',
}: FileBrowserBodyProps) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  if (loading && entries.length === 0) {
    return <FileListSkeleton layoutMode={layoutMode} />;
  }

  if (error && entries.length === 0) {
    return (
      <View style={[styles.fill, styles.center, styles.error, { backgroundColor: colors.card }]}>
        <Text style={[styles.errorTitle, { color: colors.foreground }]}>加载失败</Text>
        <Text style={[styles.errorMessage, { color: colors.mutedForeground }]}>{error}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => { void onRefresh(); }}
          style={[styles.retry, { borderColor: colors.border }]}
        >
          <Text style={{ color: colors.foreground }}>重试</Text>
        </Pressable>
      </View>
    );
  }

  if (!loading && entries.length === 0 && !hasMore) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: colors.card }]}>
        <EmptyState
          testID="file-empty-state"
          icon={EntityIcons.files}
          title={emptyVariant === 'all' ? '还没有文件' : '文件夹是空的'}
          description="让 AI 帮你生成报告、代码或数据，产物会自动出现在这里"
        />
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.card }]} onLayout={handleLayout}>
      {layoutMode === 'grid' ? (
        <FileGrid
          entries={entries}
          refreshing={loading}
          onRefresh={onRefresh}
          onPress={onPress}
          contentPaddingBottom={contentPaddingBottom}
          selectMode={selectMode}
          selectedPaths={selectedPaths}
          onSelectToggle={onSelectToggle}
          width={width}
          loadingMore={loadingMore}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
        />
      ) : (
        <FileList
          entries={entries}
          loading={loading}
          onRefresh={onRefresh}
          onPress={onPress}
          onDelete={onDelete}
          contentPaddingBottom={contentPaddingBottom}
          showPath={showPath}
          enableBackGesture={enableBackGesture}
          selectMode={selectMode}
          selectedPaths={selectedPaths}
          onSelectToggle={onSelectToggle}
          loadingMore={loadingMore}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { justifyContent: 'center' },
  error: { alignItems: 'center', paddingHorizontal: spacing.xl, gap: spacing.sm },
  errorTitle: { fontSize: 16, fontWeight: '600' },
  errorMessage: { fontSize: 13, textAlign: 'center' },
  retry: { marginTop: spacing.xs, borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  skeletonList: {
    flex: 1,
    paddingTop: spacing.sm,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  skeletonRowText: {
    flex: 1,
  },
  skeletonGrid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: spacing.sm,
  },
  skeletonCell: {
    width: '25%',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
  },
});
