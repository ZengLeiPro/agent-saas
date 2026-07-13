import React, { useCallback, useState, useMemo, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  RefreshControl,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import type { ChatSessionIndexItem, ApiSessionListItem, AgentProfile } from '@agent/shared';
import { useGroups, useGroupedSessions, fetchGroupSessions, authFetch, fetchAllAgentProfiles, fetchAgentProfile } from '@agent/shared';
import { DropdownMenu, type DropdownSection } from '../../../../src/components/overlays/DropdownMenu';
import { MoreHorizontal, ChevronLeft, Trash2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChatAppState } from '../../../../src/contexts/ChatAppStateContext';
import { useAuth } from '../../../../src/contexts/AuthContext';
import { SessionRow } from '../../../../src/components/SessionRow';
import type { SwipeAction, Swipeable } from '../../../../src/components/SwipeableRow';
import { useColors, spacing } from '../../../../src/theme';
import { glassFree } from '../../../../src/lib/headerItems';
import { hapticLight, hapticWarning, hapticSuccess } from '../../../../src/lib/haptics';
import { showTextPrompt } from '../../../../src/lib/prompt';
import { useTabBar } from '../../../../src/contexts/TabBarContext';

function toSidebarSessions(sessions: ApiSessionListItem[]): ChatSessionIndexItem[] {
  return sessions.map((s) => ({
    id: s.sessionId,
    title: s.title || '新对话',
    createdAt: s.createdAtMs || s.updatedAtMs,
    updatedAt: s.updatedAtMs,
    preview: s.preview,
    source: s.source,
    owner: s.owner,
    cronJobId: s.cronJobId,
    cronJobName: s.cronJobName,
  }));
}

export default function GroupDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { groupKey, name } = useLocalSearchParams<{ groupKey: string; name: string }>();
  const router = useRouter();
  const chat = useChatAppState();
  const { user: authUser } = useAuth();
  const isAdminUser = authUser?.role === 'admin';
  const isReadOnlyGroups = isAdminUser && chat.ownerFilter === null;
  const groupsHook = useGroups();
  const { setTabBarHidden } = useTabBar();

  const listRef = useRef<any>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const openSwipeableRef = useRef<Swipeable | null>(null);

  // Agent avatar map
  const [avatarMap, setAvatarMap] = useState<Record<string, { avatar?: string; avatarVersion?: number }>>({});
  useEffect(() => {
    (async () => {
      try {
        if (isAdminUser) {
          const profiles = await fetchAllAgentProfiles();
          const map: Record<string, { avatar?: string; avatarVersion?: number }> = {};
          for (const p of profiles) map[p.username] = { avatar: p.avatar, avatarVersion: p.avatarVersion };
          setAvatarMap(map);
        } else if (authUser?.username) {
          const profile = await fetchAgentProfile(authUser.username);
          setAvatarMap({ [authUser.username]: { avatar: profile.avatar, avatarVersion: profile.avatarVersion } });
        }
      } catch { /* ignore */ }
    })();
  }, [isAdminUser, authUser?.username]);

  // Multi-select state
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const selectedCount = selectedIds.size;
  const hasSelection = selectedCount > 0;

  // Full sessions fetched from dedicated API (background)
  const [fullSessions, setFullSessions] = useState<ChatSessionIndexItem[] | null>(null);
  const [isLoadingFull, setIsLoadingFull] = useState(false);

  // Derive group children from already-loaded chat.sessions (instant, may be incomplete)
  const sidebarSessions = useMemo(() => toSidebarSessions(chat.sessions), [chat.sessions]);
  const groupedEntries = useGroupedSessions(sidebarSessions, '', groupsHook.groups);
  const group = useMemo(() => {
    for (const e of groupedEntries) {
      if (e.type === 'group' && e.group.groupKey === groupKey) return e.group;
    }
    return null;
  }, [groupedEntries, groupKey]);

  const cachedChildren = group?.children ?? [];

  // Use full sessions when available, otherwise fall back to cached
  const children = fullSessions ?? cachedChildren;

  // Background fetch complete group sessions on mount
  const fetchFullSessions = useCallback(async () => {
    if (!groupKey) return;
    setIsLoadingFull(true);
    try {
      const sessions = await fetchGroupSessions(groupKey);
      setFullSessions(toSidebarSessions(sessions));
    } catch {
      // Failed — keep showing cached data
    } finally {
      setIsLoadingFull(false);
    }
  }, [groupKey]);

  useEffect(() => {
    void fetchFullSessions();
  }, [fetchFullSessions]);

  // --- Multi-select helpers ---
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const enterSelectMode = useCallback(() => {
    hapticLight();
    openSwipeableRef.current?.close();
    setIsSelectMode(true);
    setSelectedIds(new Set());
    requestAnimationFrame(() => setTabBarHidden(true));
  }, [setTabBarHidden]);

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
    requestAnimationFrame(() => setTabBarHidden(false));
  }, [setTabBarHidden]);

  const handleToggleAll = useCallback(() => {
    hapticLight();
    if (selectedIds.size === children.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(children.map(s => s.id)));
    }
  }, [selectedIds.size, children]);

  const handleSelectSession = useCallback((sessionId: string) => {
    if (openSwipeableRef.current) {
      openSwipeableRef.current.close();
      return;
    }
    hapticLight();
    chat.selectSession(sessionId);
    router.push(`/chat/${sessionId}`);
  }, [chat.selectSession, router]);

  const handleDeleteSession = useCallback((sessionId: string) => {
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
            // Remove from local full sessions list
            setFullSessions(prev => prev?.filter(s => s.id !== sessionId) ?? null);
          },
        },
      ],
    );
  }, [chat, isAdminUser]);

  const handleRemoveFromGroup = useCallback((sessionId: string) => {
    if (!groupKey) return;
    void groupsHook.removeSessionsFromGroup(groupKey, [sessionId]);
    // Optimistically remove from local list
    setFullSessions(prev => prev?.filter(s => s.id !== sessionId) ?? null);
  }, [groupsHook, groupKey]);

  // --- Batch action handlers ---
  const handleBatchRemove = useCallback(() => {
    if (!hasSelection || !groupKey) return;
    hapticWarning();
    const ids = [...selectedIds];
    Alert.alert(
      '移出分组',
      `确定要将 ${ids.length} 个会话移出当前分组吗？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '移出',
          style: 'destructive',
          onPress: () => {
            void groupsHook.removeSessionsFromGroup(groupKey, ids);
            setFullSessions(prev => prev?.filter(s => !selectedIds.has(s.id)) ?? null);
            exitSelectMode();
            hapticSuccess();
          },
        },
      ],
    );
  }, [hasSelection, selectedIds, groupKey, groupsHook, exitSelectMode]);

  const handleBatchDelete = useCallback(() => {
    if (!hasSelection) return;
    hapticWarning();

    const ids = [...selectedIds];
    Alert.alert(
      isAdminUser ? '批量移至回收站' : '批量删除',
      `确定要删除 ${ids.length} 个会话吗？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: isAdminUser ? '移至回收站' : '删除',
          style: 'destructive',
          onPress: async () => {
            for (const sid of ids) {
              try {
                await authFetch(`/api/sessions/${encodeURIComponent(sid)}?deleteSidecar=true`, {
                  method: 'DELETE',
                });
              } catch { /* ignore individual failures */ }
            }
            // Optimistically remove from local list
            setFullSessions(prev => prev?.filter(s => !selectedIds.has(s.id)) ?? null);
            await chat.refreshSessions();
            exitSelectMode();
            hapticSuccess();
          },
        },
      ],
    );
  }, [hasSelection, selectedIds, isAdminUser, chat, exitSelectMode]);

  const getActions = useCallback((session: ChatSessionIndexItem): SwipeAction[] => {
    const actions: SwipeAction[] = [];
    if (!isReadOnlyGroups) {
      actions.push({
        key: 'ungroup',
        label: '移出',
        backgroundColor: colors.actions.organize,
        color: colors.actions.onAction,
        onPress: () => handleRemoveFromGroup(session.id),
      });
    }
    actions.push(
      {
        key: 'rename',
        label: '重命名',
        backgroundColor: colors.actions.edit,
        color: colors.actions.onAction,
        onPress: () => {
          hapticLight();
          showTextPrompt({
            title: '重命名',
            defaultValue: session.title || '',
            extraAction: {
              label: '自动',
              onPress: () => { void chat.autoTitleSession(session.id); },
            },
            onConfirm: (newTitle) => {
              const trimmed = newTitle.trim();
              if (trimmed) void chat.renameSession(session.id, trimmed);
            },
          });
        },
      },
      {
        key: 'delete',
        label: '删除',
        backgroundColor: colors.actions.destructive,
        color: colors.actions.onAction,
        onPress: () => handleDeleteSession(session.id),
      },
    );
    return actions;
  }, [handleRemoveFromGroup, handleDeleteSession, isReadOnlyGroups]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.card,
    },
    contentArea: {
      flex: 1,
    },
    empty: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 80,
    },
    emptyText: {
      fontSize: 15,
      color: colors.mutedForeground,
    },
    headerTitle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    headerTitleText: {
      fontSize: 17,
      fontWeight: '600',
      color: colors.foreground,
    },
    headerText: {
      fontSize: 17,
      color: colors.foreground,
    },
    // Bottom pill buttons
    bottomPillContainer: {
      position: 'absolute',
      bottom: insets.bottom + 8,
      left: spacing.lg,
      right: spacing.lg,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      zIndex: 100,
    },
    pillInner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      height: 50,
      paddingHorizontal: 22,
      borderRadius: 25,
    },
    pillFallback: {
      backgroundColor: colors.muted,
    },
    pillText: {
      fontSize: 17,
      fontWeight: '600',
    },
    iconPillInner: {
      width: 50,
      height: 50,
      borderRadius: 25,
      alignItems: 'center',
      justifyContent: 'center',
    },
  }), [colors, insets.top, insets.bottom]);

  const showOwner = isAdminUser && chat.ownerFilter === null;

  const renderItem = useCallback(({ item }: { item: ChatSessionIndexItem }) => {
    const ownerUsername = item.owner?.username || authUser?.username || '';
    const ownerAvatar = avatarMap[ownerUsername];
    return (
      <SessionRow
        session={item}
        actions={getActions(item)}
        openRowRef={openSwipeableRef}
        onPress={handleSelectSession}
        enableBackGesture={!isSelectMode}
        showOwner={showOwner}
        selectMode={isSelectMode}
        selected={selectedIds.has(item.id)}
        onSelectToggle={() => toggleSelect(item.id)}
        agentAvatar={ownerAvatar?.avatar}
        agentAvatarVersion={ownerAvatar?.avatarVersion}
        agentAvatarUsername={ownerUsername}
      />
    );
  }, [getActions, handleSelectSession, showOwner, isSelectMode, selectedIds, toggleSelect, avatarMap, authUser?.username]);

  const keyExtractor = useCallback((item: ChatSessionIndexItem) => item.id, []);

  const displayName = group?.name ?? name ?? '分组';
  const isCronGroup = group?.kind === 'cron';

  const [headerMenuVisible, setHeaderMenuVisible] = useState(false);
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState(0);
  const headerMenuTriggerRef = useRef<View>(null);

  const groupMenuSections = useMemo<DropdownSection[]>(() => {
    const actions: { id: string; label: string }[] = [];
    if (!isCronGroup) {
      actions.push({ id: '_rename_group', label: '重命名分组' });
    }
    actions.push({ id: '_delete_group', label: '删除分组' });
    return [{ id: 'group-actions', actions }];
  }, [isCronGroup]);

  const handleGroupMenuSelect = useCallback((actionId: string) => {
    if (!groupKey) return;
    if (actionId === '_rename_group') {
      showTextPrompt({
        title: '重命名分组',
        message: '输入新的分组名称',
        defaultValue: displayName,
        onConfirm: (newName) => {
          const trimmed = newName.trim();
          if (trimmed) void groupsHook.renameGroup(groupKey, trimmed);
        },
      });
    } else if (actionId === '_delete_group') {
      Alert.alert(
        '删除分组',
        '删除分组后，分组内的会话不会被删除。',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '删除',
            style: 'destructive',
            onPress: () => {
              void groupsHook.deleteGroup(groupKey).then(() => router.back());
            },
          },
        ],
      );
    }
  }, [groupKey, groupsHook, displayName, router]);

  const handleOpenHeaderMenu = useCallback(() => {
    hapticLight();
    headerMenuTriggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setHeaderMenuAnchor(y + h);
      setHeaderMenuVisible(true);
    });
  }, []);

  const canBatchRemove = hasSelection && !isReadOnlyGroups;

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.headerTitle}>
              <Text style={styles.headerTitleText} numberOfLines={1}>{displayName}</Text>
              {isLoadingFull && (
                <ActivityIndicator size="small" color={colors.mutedForeground} />
              )}
            </View>
          ),
          headerRight: () =>
            isSelectMode ? (
              <TouchableOpacity onPress={handleToggleAll} activeOpacity={0.7}>
                <Text style={styles.headerText}>
                  {selectedIds.size === children.length && children.length > 0 ? '取消全选' : '全选'}
                </Text>
              </TouchableOpacity>
            ) : !isReadOnlyGroups ? (
              <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
                <MoreHorizontal size={22} color={colors.foreground} strokeWidth={2} />
              </Pressable>
            ) : null,
          unstable_headerRightItems: () =>
            isSelectMode ? [glassFree(
              <TouchableOpacity onPress={handleToggleAll} activeOpacity={0.7}>
                <Text style={styles.headerText}>
                  {selectedIds.size === children.length && children.length > 0 ? '取消全选' : '全选'}
                </Text>
              </TouchableOpacity>
            )] : !isReadOnlyGroups ? [glassFree(
              <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
                <MoreHorizontal size={22} color={colors.foreground} strokeWidth={2} />
              </Pressable>
            )] : [],
          headerBackVisible: false,
          headerLeft: () => isSelectMode ? (
            <TouchableOpacity onPress={exitSelectMode} activeOpacity={0.7}>
              <Text style={styles.headerText}>完成</Text>
            </TouchableOpacity>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7} style={{ padding: 4 }}>
                <ChevronLeft size={22} color={colors.foreground} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity onPress={enterSelectMode} activeOpacity={0.7}>
                <Text style={styles.headerText}>选择</Text>
              </TouchableOpacity>
            </View>
          ),
          unstable_headerLeftItems: () => isSelectMode
            ? [glassFree(
                <TouchableOpacity onPress={exitSelectMode} activeOpacity={0.7}>
                  <Text style={styles.headerText}>完成</Text>
                </TouchableOpacity>
              )]
            : [
                glassFree(
                  <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7} style={{ padding: 4 }}>
                    <ChevronLeft size={22} color={colors.foreground} strokeWidth={2} />
                  </TouchableOpacity>
                ),
                glassFree(
                  <TouchableOpacity onPress={enterSelectMode} activeOpacity={0.7}>
                    <Text style={styles.headerText}>选择</Text>
                  </TouchableOpacity>
                ),
              ],
        }}
      />
      <View style={styles.contentArea}>
        <FlashList
          ref={listRef}
          data={children}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={{
            paddingBottom: isSelectMode ? insets.bottom + 70 : insets.bottom,
          }}
          onScrollBeginDrag={() => openSwipeableRef.current?.close()}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => {
                setIsRefreshing(true);
                void Promise.all([
                  chat.refreshSessions(),
                  fetchFullSessions(),
                ]).finally(() => setIsRefreshing(false));
              }}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>暂无会话</Text>
            </View>
          }
        />
      </View>

      {/* Bottom pill buttons in select mode */}
      {isSelectMode && (
        <View style={styles.bottomPillContainer}>
          <TouchableOpacity onPress={handleBatchRemove} disabled={!canBatchRemove} activeOpacity={0.7}>
            {renderGlass(styles.pillInner, (
              <>
                <Text style={[styles.pillText, { color: colors.foreground }]}>
                  移出{hasSelection ? ` (${selectedCount})` : ''}
                </Text>
              </>
            ))}
          </TouchableOpacity>

          <TouchableOpacity onPress={handleBatchDelete} disabled={!hasSelection} activeOpacity={0.7}>
            {renderGlass(styles.iconPillInner, (
              <Trash2 size={24} color={hasSelection ? colors.destructive : colors.foreground} strokeWidth={2} />
            ))}
          </TouchableOpacity>
        </View>
      )}

      {/* Header dropdown menu */}
      <DropdownMenu
        visible={headerMenuVisible}
        onClose={() => setHeaderMenuVisible(false)}
        sections={groupMenuSections}
        onSelect={handleGroupMenuSelect}
        anchorTop={headerMenuAnchor}
        align="right"
      />
    </View>
  );

  function renderGlass(style: any, children: React.ReactNode) {
    return <View style={[style, styles.pillFallback]}>{children}</View>;
  }
}
