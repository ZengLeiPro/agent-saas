/**
 * 会话列表页 —— 对齐 Web 手机浏览器版 `web/src/components/MobileSessionList.tsx`。
 *
 * 本文件只做「屏幕编排」：状态、导航、以及把列表 / pill 行 / FAB / 面板拼起来；
 * 列表行、滑动动作、分组对话框、回收站等都在 `src/components/sessions/` 下。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, InteractionManager, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';
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
import { useColors, fontScale } from '../../../src/theme';

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

  // FlashList 的 imperative 句柄，只用来恢复滚动位置。
  const listRef = useRef<any>(null);
  const openSwipeableRef = useRef<Swipeable | null>(null);
  const swipeDismissedAtRef = useRef(0);
  const didRestoreAnchorRef = useRef(false);

  const groupsHook = useGroups();
  const avatarMap = useSessionAvatarMap({ isAdmin: isAdminUser, username: authUser?.username });
  // 个人偏好 `showSessionListAvatar`（设置 → 外观与布局）；
  // 移动端缺省显示头像，与 Web 缺省相反，理由见 app/settings/appearance-layout.tsx。
  const showSessionListAvatar = authUser?.preferences?.showSessionListAvatar !== false;

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
      router.push(`/chat/${sessionId}`);
    },
    [chat, router, closeOpenSwipeable],
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
    onNavigate: (path) => router.push(path as never),
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
          agentAvatar={ownerAvatar?.avatar}
          agentAvatarVersion={ownerAvatar?.avatarVersion}
          agentAvatarUsername={ownerUsername}
          showAvatar={showSessionListAvatar}
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
      showSessionListAvatar,
      getSessionActions,
      handleSelectSession,
      selection,
    ],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.card },
        headerText: { ...fontScale.base, color: colors.foreground },
      }),
    [colors],
  );

  const headerLeft = () => (
    <TouchableOpacity
      onPress={selection.isSelectMode ? selection.exitSelectMode : selection.enterSelectMode}
      activeOpacity={0.7}
    >
      <Text style={styles.headerText}>{selection.isSelectMode ? '完成' : '选择'}</Text>
    </TouchableOpacity>
  );

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
    </View>
  );
}
