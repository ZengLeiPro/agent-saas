/**
 * 会话列表页 —— 对齐 Web 手机浏览器版 `web/src/components/MobileSessionList.tsx`。
 *
 * 本文件只做「屏幕编排」：状态、导航、以及把列表 / pill 行 / FAB / 面板拼起来；
 * 列表行、滑动动作、分组对话框、回收站等都在 `src/components/sessions/` 下。
 *
 * P0–P5 iPad / 宽屏（md≥768）：单栏会话 chrome + 列表|详情 master-detail（头像默认显示）；
 * 窄主栏保护可折叠/汉堡唤起列表（`sidebar-collapsed`）；lg+ 右栏可 dock；窄屏仍 push 栈。不托管 apps。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, InteractionManager, LayoutChangeEvent, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Menu, PanelLeftClose, Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SessionGroup } from '@agent/shared';
import {
  resolveSwipeSelectGuard,
  selectGroupUnreadMap,
  useGroupedSessions,
  useGroups,
} from '@agent/shared';
import { useChatAppState } from '../../../src/contexts/ChatAppStateContext';
import { useAuth } from '../../../src/contexts/AuthContext';
import { useTabBar } from '../../../src/contexts/TabBarContext';
import { SessionRow } from '../../../src/components/SessionRow';
import type { Swipeable } from '../../../src/components/SwipeableRow';
import {
  GroupPickerSheet,
  SessionGroupRow,
  SessionListFabs,
  SessionListView,
  SessionPillRow,
  SessionSelectionBar,
  TrashSheet,
  useNewSessionLauncher,
  useSessionAvatarMap,
  useSessionGroupActions,
  useSessionRowActions,
  useSessionSelection,
  type SessionListItem,
} from '../../../src/components/sessions';
import { glassFree } from '../../../src/lib/headerItems';
import { hapticLight, hapticWarning } from '../../../src/lib/haptics';
import { readSessionListAnchor } from '../../../src/lib/sessionListAnchor';
import { toSidebarSessions } from '../../../src/lib/sessionListAdapter';
import { useColors, fontScale, spacing, radius, shadows } from '../../../src/theme';
import { FLOATING_MAIN_INSET, MASTER_LIST_WIDTH } from '../../../src/lib/layoutDensity';
import { EmptyState } from '../../../src/components/ui';
import { useBreakpoint } from '../../../src/hooks/useBreakpoint';
import { useMasterListCollapse } from '../../../src/hooks/useMasterListCollapse';
import { MasterListOverlay } from '../../../src/components/layout';
import { ChatSessionScreen } from '../../../src/components/chat/ChatSessionScreen';
import { ICON_SIZE, ICON_STROKE } from '../../../src/lib/icons';

/** 分组定时刷新周期（ms），与会话轮询保持一致 */
const GROUPS_REFRESH_MS = 30_000;

export default function SessionListScreen() {
  const colors = useColors();
  const chat = useChatAppState();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { setTabBarHidden } = useTabBar();
  const { user: authUser } = useAuth();

  const isAdminUser = authUser?.role === 'admin';
  const isReadOnlyGroups = isAdminUser && chat.ownerFilter === null;
  const showOwner = isAdminUser && chat.ownerFilter === null;

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  const { isMdUp, width: breakpointWidth } = useBreakpoint();
  // md+ master-detail selection (null = empty pane「请选择会话」)
  const [paneSessionId, setPaneSessionId] = useState<string | null>(null);
  const [splitWidth, setSplitWidth] = useState(0);
  const collapse = useMasterListCollapse({
    enabled: isMdUp,
    containerWidth: splitWidth > 0 ? splitWidth : breakpointWidth,
  });
  const handleSplitLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setSplitWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  }, []);

  // FlashList 的 imperative 句柄，只用来恢复滚动位置。
  const listRef = useRef<any>(null);
  const openSwipeableRef = useRef<Swipeable | null>(null);
  const swipeDismissedAtRef = useRef(0);
  const didRestoreAnchorRef = useRef(false);

  const groupsHook = useGroups();
  const avatarMap = useSessionAvatarMap({ isAdmin: isAdminUser, username: authUser?.username });
  // 头像列永远显示：不读取 Web 共享偏好 `showSessionListAvatar`，
  // 避免个人会话与固定带图标的分组行错位（见 SessionRow）。

  const sidebarSessions = useMemo(
    () => toSidebarSessions(chat.sessions, chat.loading ? chat.sessionId : null),
    [chat.sessions, chat.loading, chat.sessionId],
  );
  const groupedEntries = useGroupedSessions(sidebarSessions, '', groupsHook.groups);
  const groupUnread = useMemo(
    () => selectGroupUnreadMap(groupsHook.groups, sidebarSessions),
    [groupsHook.groups, sidebarSessions],
  );

  const groupActions = useSessionGroupActions({
    groupsHook,
    sessions: sidebarSessions,
    onCompleted: () => selectionRef.current?.exitSelectMode(),
  });

  const restoreListAnchor = useCallback(() => {
    if (!didRestoreAnchorRef.current) return;
    InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: readSessionListAnchor(), animated: false });
      });
    });
  }, []);

  // Provider 持有分页器，详情页返回后恢复列表视口。
  useEffect(() => {
    if (chat.sessionsHydrated && !didRestoreAnchorRef.current) {
      didRestoreAnchorRef.current = true;
      restoreListAnchor();
    }
  }, [chat.sessionsHydrated, restoreListAnchor]);

  useEffect(() => {
    const interval = setInterval(() => {
      void groupsHook.loadGroups();
    }, GROUPS_REFRESH_MS);
    return () => clearInterval(interval);
  }, [groupsHook.loadGroups]);

  const closeOpenSwipeable = useCallback(() => {
    if (!openSwipeableRef.current) return;
    openSwipeableRef.current.close();
    openSwipeableRef.current = null;
    swipeDismissedAtRef.current = Date.now();
  }, []);

  const listDataAll = useMemo<SessionListItem[]>(
    () => groupedEntries.filter((e): e is SessionListItem => e.type === 'session' || e.type === 'group'),
    [groupedEntries],
  );

  const selection = useSessionSelection({
    isAdminUser,
    allRowIds: useMemo(
      () =>
        listDataAll.map((item) =>
          item.type === 'group' ? `group-${item.group.groupKey}` : item.session.id,
        ),
      [listDataAll],
    ),
    refreshSessions: chat.refreshSessions,
    setTabBarHidden,
    closeOpenSwipeable,
  });

  // groupActions 在 selection 之前创建，用 ref 回读最新的退出多选回调。
  const selectionRef = useRef<typeof selection | null>(null);
  selectionRef.current = selection;

  // 多选模式下隐藏分组行，只批量操作普通会话。
  const listData = useMemo(
    () => (selection.isSelectMode ? listDataAll.filter((item) => item.type === 'session') : listDataAll),
    [listDataAll, selection.isSelectMode],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      const guard = resolveSwipeSelectGuard({
        hasOpenRow: openSwipeableRef.current !== null,
        dismissedAt: swipeDismissedAtRef.current,
        now: Date.now(),
      });
      if (guard === 'close-open-row') {
        closeOpenSwipeable();
        return;
      }
      if (guard === 'suppress') return;
      hapticLight();
      chat.selectSession(sessionId);
      if (isMdUp) {
        setPaneSessionId(sessionId);
        collapse.onMasterItemSelected();
        return;
      }
      router.push(`/chat/${sessionId}`);
    },
    [chat, router, closeOpenSwipeable, isMdUp, collapse],
  );

  const handleGroupClick = useCallback(
    (group: SessionGroup) => {
      const guard = resolveSwipeSelectGuard({
        hasOpenRow: openSwipeableRef.current !== null,
        dismissedAt: swipeDismissedAtRef.current,
        now: Date.now(),
      });
      if (guard === 'close-open-row') {
        closeOpenSwipeable();
        return;
      }
      if (guard === 'suppress') return;
      hapticLight();
      router.push(
        `/(tabs)/chat/group/${group.groupKey}?name=${encodeURIComponent(group.name)}`,
      );
    },
    [router, closeOpenSwipeable],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      hapticWarning();
      Alert.alert(
        isAdminUser ? '移至回收站' : '删除会话',
        isAdminUser ? '会话将移至回收站，可随时恢复。' : '确定要删除这个会话吗？',
        [
          { text: '取消', style: 'cancel' },
          {
            text: isAdminUser ? '移至回收站' : '删除',
            style: 'destructive',
            onPress: () => {
              void chat.handleDeleteSession(sessionId);
            },
          },
        ],
      );
    },
    [chat, isAdminUser],
  );

  const getSessionActions = useSessionRowActions({
    readOnlyGroups: isReadOnlyGroups,
    onOpenGroupPicker: (sessionId) => groupActions.openPicker([sessionId]),
    onRename: (sessionId, title) => {
      void chat.renameSession(sessionId, title);
    },
    onAutoTitle: (sessionId) => {
      void chat.autoTitleSession(sessionId);
    },
    onDelete: handleDeleteSession,
  });

  const handleNewSession = useNewSessionLauncher({
    chat,
    isAdminUser,
    onNavigate: (path) => {
      if (isMdUp && (path === '/chat/new' || path.startsWith('/chat/'))) {
        const id = path === '/chat/new' ? 'new' : path.replace(/^\/chat\//, '');
        setPaneSessionId(id);
        return;
      }
      router.push(path as never);
    },
  });

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void Promise.all([chat.refreshSessions(), groupsHook.loadGroups()]).finally(() =>
      setIsRefreshing(false),
    );
  }, [chat, groupsHook]);

  const renderItem = useCallback(
    ({ item }: { item: SessionListItem }) => {
      if (item.type === 'group') {
        return (
          <SessionGroupRow
            group={item.group}
            unread={groupUnread.get(item.group.groupKey) === true}
            showOwner={showOwner}
            readOnly={isReadOnlyGroups}
            openRowRef={openSwipeableRef}
            onPress={handleGroupClick}
            onRename={groupActions.promptRenameGroup}
            onDelete={groupActions.confirmDeleteGroup}
          />
        );
      }
      const ownerUsername = item.session.owner?.username || authUser?.username || '';
      const ownerAvatar = avatarMap[ownerUsername];
      return (
        <SessionRow
          session={item.session}
          actions={getSessionActions(item.session)}
          openRowRef={openSwipeableRef}
          onPress={handleSelectSession}
          showOwner={showOwner}
          selectMode={selection.isSelectMode}
          selected={selection.selectedIds.has(item.session.id)}
          onSelectToggle={() => selection.toggleSelect(item.session.id)}
          active={isMdUp && paneSessionId === item.session.id}
          dense={isMdUp}
          agentAvatar={ownerAvatar?.avatar}
          agentAvatarVersion={ownerAvatar?.avatarVersion}
          agentAvatarUsername={ownerUsername}
        />
      );
    },
    [
      groupUnread,
      showOwner,
      isReadOnlyGroups,
      handleGroupClick,
      groupActions.promptRenameGroup,
      groupActions.confirmDeleteGroup,
      authUser?.username,
      avatarMap,
      getSessionActions,
      handleSelectSession,
      selection,
      isMdUp,
      paneSessionId,
    ],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.card },
        split: { flex: 1, flexDirection: 'row' },
        listPane: { flex: 1, backgroundColor: colors.card },
        listPaneWide: {
          width: MASTER_LIST_WIDTH,
          maxWidth: '42%',
          borderRightWidth: StyleSheet.hairlineWidth,
          borderRightColor: colors.border,
          backgroundColor: colors.card,
        },
        detailHost: {
          flex: 1,
          paddingVertical: FLOATING_MAIN_INSET,
          paddingRight: FLOATING_MAIN_INSET,
          paddingLeft: collapse.hideMaster ? FLOATING_MAIN_INSET : 0,
          backgroundColor: colors.background,
        },
        headerLeftRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
        detailPane: {
          flex: 1,
          borderRadius: radius.xl,
          overflow: 'hidden',
          backgroundColor: colors.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          ...shadows.card,
        },
        emptyPane: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
        },
        headerText: { ...fontScale.base, color: colors.foreground },
      }),
    [colors, collapse.hideMaster],
  );

  const headerLeft = () => {
    if (isMdUp && collapse.hideMaster) {
      return (
        <TouchableOpacity
          onPress={collapse.onHamburgerPress}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="打开会话列表"
          testID="chat-master-hamburger"
        >
          <Menu size={ICON_SIZE.feature} color={colors.foreground} strokeWidth={ICON_STROKE.default} />
        </TouchableOpacity>
      );
    }
    const selectBtn = (
      <TouchableOpacity
        onPress={selection.isSelectMode ? selection.exitSelectMode : selection.enterSelectMode}
        activeOpacity={0.7}
      >
        <Text style={styles.headerText}>{selection.isSelectMode ? '完成' : '选择'}</Text>
      </TouchableOpacity>
    );
    if (isMdUp && !selection.isSelectMode) {
      return (
        <View style={styles.headerLeftRow}>
          <TouchableOpacity
            onPress={collapse.togglePersistent}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="折叠会话列表"
            testID="chat-master-collapse"
          >
            <PanelLeftClose size={ICON_SIZE.feature} color={colors.foreground} strokeWidth={ICON_STROKE.default} />
          </TouchableOpacity>
          {selectBtn}
        </View>
      );
    }
    return selectBtn;
  };

  const headerRight = () =>
    selection.isSelectMode ? (
      <TouchableOpacity onPress={selection.toggleAll} activeOpacity={0.7}>
        <Text style={styles.headerText}>{selection.allSelected ? '取消全选' : '全选'}</Text>
      </TouchableOpacity>
    ) : (
      <TouchableOpacity onPress={handleNewSession} activeOpacity={0.7}>
        <Plus size={24} color={colors.foreground} strokeWidth={2} />
      </TouchableOpacity>
    );

  const listBody = (
      <>
      <SessionListView
        listKey={`${selection.isSelectMode ? 'select' : 'list'}-${chat.sessionsHydrated ? 'hydrated' : 'cold'}`}
        listRef={listRef}
        data={listData}
        renderItem={renderItem}
        showSkeleton={chat.isLoadingSessions && chat.sessions.length === 0}
        isRefreshing={isRefreshing}
        onRefresh={handleRefresh}
        hasMore={chat.hasMoreSessions}
        isLoadingMore={chat.isLoadingMoreSessions}
        onLoadMore={() => void chat.loadMoreSessions()}
        header={
          selection.isSelectMode ? null : (
            <SessionPillRow trashOpen={trashOpen} onToggleTrash={() => setTrashOpen((v) => !v)} />
          )
        }
        contentBottomPadding={insets.bottom + (selection.isSelectMode ? 70 : 88)}
        onListLoad={restoreListAnchor}
        onScrollBeginDrag={closeOpenSwipeable}
      />

      {selection.isSelectMode ? (
        <SessionSelectionBar
          selectedCount={selection.selectedCount}
          canGroup={!isReadOnlyGroups}
          onGroup={() => groupActions.openPicker([...selection.selectedIds])}
          onDelete={selection.batchDelete}
        />
      ) : (
        <SessionListFabs
          hasManualGroups={groupActions.hasManualGroups}
          disabled={chat.isLoadingSessions && chat.sessions.length === 0}
          onNewSession={handleNewSession}
          onNewGroup={groupActions.promptCreateEmptyGroup}
        />
      )}

      <GroupPickerSheet
        visible={groupActions.pickerVisible}
        onClose={groupActions.closePicker}
        groups={groupActions.allGroups}
        onSelectGroup={groupActions.addToGroup}
        onCreateGroupRequested={groupActions.promptCreateGroupForPending}
      />

      <TrashSheet
        visible={trashOpen}
        onClose={() => setTrashOpen(false)}
        onChanged={() => void chat.refreshSessions()}
      />
      </>
  );

  return (
    <View style={styles.container} testID="chat-home-screen">
      <Stack.Screen
        options={{
          title: 'Agent SaaS',
          headerLeft,
          unstable_headerLeftItems: () => [glassFree(headerLeft())],
          headerRight,
          unstable_headerRightItems: () => [glassFree(headerRight())],
        }}
      />

      {isMdUp ? (
        <View style={styles.split} testID="chat-master-detail" onLayout={handleSplitLayout}>
          {collapse.hideMaster ? null : <View style={styles.listPaneWide}>{listBody}</View>}
          <View style={styles.detailHost}>
            <View style={styles.detailPane}>
              {paneSessionId ? (
                <ChatSessionScreen
                  sessionId={paneSessionId}
                  presentation="pane"
                  onClosePane={() => setPaneSessionId(null)}
                  onSessionNavigate={(id) => setPaneSessionId(id)}
                />
              ) : (
                <View style={styles.emptyPane} testID="chat-pane-empty">
                  <EmptyState title="请选择会话" description="从左侧列表打开会话，或新建一个对话。" />
                </View>
              )}
            </View>
          </View>
          <MasterListOverlay
            visible={collapse.masterOverlayOpen}
            onDismiss={collapse.dismissMasterOverlay}
            testID="chat-master-overlay"
          >
            {listBody}
          </MasterListOverlay>
        </View>
      ) : (
        <View style={styles.listPane}>{listBody}</View>
      )}
    </View>
  );
}
