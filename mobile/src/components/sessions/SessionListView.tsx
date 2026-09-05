/**
 * 会话列表主体 —— 对齐 Web `MobileSessionList` 的滚动区。
 *
 * 负责：下拉刷新（触发时带震动反馈）、距底 200px 触发下一页、底部
 * 「没有更多了」/ 加载中、空态，以及把滚动位置回传给列表锚点。
 *
 * 手感说明：FlashList 只支持系统 `RefreshControl`，无法定制 Web
 * `PullToRefresh` 的橡皮筋（触发 100 / 最大 200 / 指示器 88 / 300ms），
 * 因此这里保留系统指示器，但把「越过触发点时给一次轻震动」的时机对齐。
 */
import React, { useCallback, useMemo, useRef } from 'react';
import {
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import type { ChatSessionIndexItem, SessionGroup } from '@agent/shared';
import { shouldLoadMoreOnScroll } from '@agent/shared';
import { SkeletonList } from '../SkeletonList';
import { hapticLight } from '../../lib/haptics';
import { captureSessionListAnchor } from '../../lib/sessionListAnchor';
import { useColors, spacing, typography } from '../../theme';

export type SessionListItem =
  { type: 'session'; session: ChatSessionIndexItem } | { type: 'group'; group: SessionGroup };

/** 单行估算高度，与 SessionRow / SessionGroupRow 的 minHeight 一致 */
export const LIST_ITEM_ESTIMATED_SIZE = 62;

export interface SessionListViewProps {
  data: SessionListItem[];
  renderItem: ListRenderItem<SessionListItem>;
  /** 冷启动骨架屏：首次加载且尚无数据 */
  showSkeleton: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  /** 列表顶部固定区（pill 行） */
  header?: React.ReactElement | null;
  contentBottomPadding: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FlashList ref 类型随泛型变化，这里只透传
  listRef?: React.MutableRefObject<any>;
  onListLoad?: () => void;
  onScrollBeginDrag?: () => void;
  /** 多选模式切换需要重建列表 */
  listKey: string;
}

export function SessionListView({
  data,
  renderItem,
  showSkeleton,
  isRefreshing,
  onRefresh,
  hasMore,
  isLoadingMore,
  onLoadMore,
  header,
  contentBottomPadding,
  listRef,
  onListLoad,
  onScrollBeginDrag,
  listKey,
}: SessionListViewProps) {
  const colors = useColors();
  const loadMoreLockRef = useRef(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1 },
        empty: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: spacing['4xl'] * 2,
        },
        emptyText: { ...typography.body, color: colors.mutedForeground },
        footer: { paddingVertical: spacing.md, alignItems: 'center' },
        footerText: { ...typography.caption, color: colors.mutedForeground },
      }),
    [colors],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      captureSessionListAnchor(contentOffset.y);
      const reachedBottom = shouldLoadMoreOnScroll({
        contentHeight: contentSize.height,
        offsetY: contentOffset.y,
        viewportHeight: layoutMeasurement.height,
      });
      if (!reachedBottom) {
        loadMoreLockRef.current = false;
        return;
      }
      if (!hasMore || isLoadingMore || loadMoreLockRef.current) return;
      loadMoreLockRef.current = true;
      onLoadMore();
    },
    [hasMore, isLoadingMore, onLoadMore],
  );

  const handleRefresh = useCallback(() => {
    hapticLight();
    onRefresh();
  }, [onRefresh]);

  if (showSkeleton) {
    return (
      <View style={styles.container}>
        {header}
        <SkeletonList />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <FlashList
        testID="chat-session-list"
        accessibilityLabel="会话列表"
        key={listKey}
        ref={listRef}
        data={data}
        renderItem={renderItem}
        keyExtractor={(item) =>
          item.type === 'group' ? `group-${item.group.groupKey}` : item.session.id
        }
        getItemType={(item) => item.type}
        drawDistance={250}
        overrideProps={{ initialDrawBatchSize: 12 }}
        onLoad={onListLoad}
        contentContainerStyle={{ paddingBottom: contentBottomPadding }}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        onScrollBeginDrag={onScrollBeginDrag}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>暂无会话</Text>
          </View>
        }
        ListFooterComponent={
          isLoadingMore ? (
            <View style={styles.footer}>
              <Text style={styles.footerText}>加载中...</Text>
            </View>
          ) : !hasMore && data.length > 0 ? (
            <View style={styles.footer}>
              <Text style={styles.footerText}>没有更多了</Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}
