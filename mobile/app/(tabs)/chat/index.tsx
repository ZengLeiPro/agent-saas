import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
  Alert,
  Pressable,
  InteractionManager,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { FlashList } from "@shopify/flash-list";
import { Ionicons } from "@expo/vector-icons";
import {
  DropdownMenu,
  type DropdownSection,
} from "../../../src/components/overlays/DropdownMenu";
import type {
  ChatSessionIndexItem,
  SessionGroup,
  AgentProfile,
} from "@agent/shared";
import { glassFree } from "../../../src/lib/headerItems";
import {
  useGroups,
  useGroupedSessions,
  formatShortDate,
  authFetch,
  fetchAllAgentProfiles,
  fetchAgentProfile,
  getPlatform,
  getSortedGroupItems,
} from "@agent/shared";
import type { ApiSessionListItem } from "@agent/shared";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useChatAppState } from "../../../src/contexts/ChatAppStateContext";
import { useAuth } from "../../../src/contexts/AuthContext";
import { SkeletonList } from "../../../src/components/SkeletonList";
import { SessionRow } from "../../../src/components/SessionRow";
import type {
  SwipeAction,
  Swipeable,
} from "../../../src/components/SwipeableRow";
import { useColors, spacing, typography } from "../../../src/theme";
import {
  hapticLight,
  hapticWarning,
  hapticSuccess,
} from "../../../src/lib/haptics";
import { showTextPrompt } from "../../../src/lib/prompt";
import { useTabBar } from "../../../src/contexts/TabBarContext";

/** Convert API sessions to sidebar format for useGroupedSessions */
function toSidebarSessions(
  sessions: ApiSessionListItem[],
): ChatSessionIndexItem[] {
  return sessions.map((s) => ({
    id: s.sessionId,
    title: s.title || "新对话",
    createdAt: s.createdAtMs || s.updatedAtMs,
    updatedAt: s.updatedAtMs,
    preview: s.preview,
    source: s.source,
    owner: s.owner,
    cronJobId: s.cronJobId,
    cronJobName: s.cronJobName,
  }));
}

type ListItem =
  | { type: "session"; session: ChatSessionIndexItem }
  | { type: "group"; group: SessionGroup };

const LIST_ITEM_ESTIMATED_SIZE = 62;

// 模块级 avatar 缓存：跨 re-mount 保持（tab 切换不丢），冷启动时由 AsyncStorage 填充
const AVATAR_CACHE_KEY = "avatarMap";
let _avatarMapModuleCache: Record<
  string,
  { avatar?: string; avatarVersion?: number }
> = {};

export default function SessionListScreen() {
  const colors = useColors();
  const chat = useChatAppState();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const { setTabBarHidden } = useTabBar();

  // Multi-select state
  const [isSelectMode, setIsSelectMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

  // Swipe group menu state
  const [swipeGroupMenuVisible, setSwipeGroupMenuVisible] =
    React.useState(false);
  const [swipeGroupMenuAnchor, setSwipeGroupMenuAnchor] = React.useState(0);
  const [swipeGroupSessionId, setSwipeGroupSessionId] = React.useState<
    string | null
  >(null);
  const swipeGroupTriggerRef = React.useRef<View>(null);
  const swipeGroupCloseRef = React.useRef<(() => void) | null>(null);

  // Batch group menu state
  const [batchGroupMenuVisible, setBatchGroupMenuVisible] =
    React.useState(false);
  const [batchGroupMenuAnchor, setBatchGroupMenuAnchor] = React.useState(0);
  const batchGroupTriggerRef = React.useRef<View>(null);

  const listRef = useRef<any>(null);
  const didScrollTopOnHydrateRef = useRef(false);
  const scrollToTopAfterHydrate = useCallback(() => {
    if (!didScrollTopOnHydrateRef.current) return;
    InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      });
    });
  }, []);

  // 冷启动时 cache-first 渲染会保留上次的 FlashList offset；
  // 首次拿到 API 数据后，等布局与转场稳定后强制回顶，避免停在旧位置。
  useEffect(() => {
    if (chat.sessionsHydrated && !didScrollTopOnHydrateRef.current) {
      didScrollTopOnHydrateRef.current = true;
      scrollToTopAfterHydrate();
    }
  }, [chat.sessionsHydrated, scrollToTopAfterHydrate]);

  // Swipe-to-reveal state
  const openSwipeableRef = useRef<Swipeable | null>(null);

  // Auth & admin state
  const { user: authUser } = useAuth();
  const isAdminUser = authUser?.role === "admin";
  const isReadOnlyGroups = isAdminUser && chat.ownerFilter === null;

  // Group state (API returns the current user's groups)
  const groupsHook = useGroups();

  // Agent avatar map: username → { avatar, avatarVersion }
  // 模块级缓存消除 re-mount 闪烁（tab 切换等场景），AsyncStorage 缓存覆盖冷启动
  const [avatarMap, setAvatarMap] = React.useState<
    Record<string, { avatar?: string; avatarVersion?: number }>
  >(_avatarMapModuleCache);
  const updateAvatarMap = useCallback(
    (map: Record<string, { avatar?: string; avatarVersion?: number }>) => {
      _avatarMapModuleCache = map;
      setAvatarMap(map);
    },
    [],
  );

  // Effect 1: 缓存读取 — 不依赖 auth，挂载即刻执行，避免被 auth 状态变化取消
  useEffect(() => {
    // 模块级缓存已有数据时跳过 AsyncStorage 读取
    if (Object.keys(_avatarMapModuleCache).length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await getPlatform().storage.getItem(AVATAR_CACHE_KEY);
        if (!cancelled && raw) {
          const cached = JSON.parse(raw) as Record<
            string,
            { avatar?: string; avatarVersion?: number }
          >;
          if (Object.keys(cached).length > 0) updateAvatarMap(cached);
        }
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 2: API 刷新 — 依赖 auth，auth 就绪后拉最新数据并回写缓存
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let map: Record<string, { avatar?: string; avatarVersion?: number }> =
          {};
        if (isAdminUser) {
          const profiles = await fetchAllAgentProfiles();
          for (const p of profiles)
            map[p.username] = {
              avatar: p.avatar,
              avatarVersion: p.avatarVersion,
            };
        } else if (authUser?.username) {
          const profile = await fetchAgentProfile(authUser.username);
          map = {
            [authUser.username]: {
              avatar: profile.avatar,
              avatarVersion: profile.avatarVersion,
            },
          };
        }
        if (!cancelled && Object.keys(map).length > 0) {
          updateAvatarMap(map);
          void getPlatform().storage.setItem(
            AVATAR_CACHE_KEY,
            JSON.stringify(map),
          );
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdminUser, authUser?.username, updateAvatarMap]);

  // Periodic groups refresh (30s) — keep in sync with sessions polling
  useEffect(() => {
    const interval = setInterval(() => {
      void groupsHook.loadGroups();
    }, 30000);
    return () => clearInterval(interval);
  }, [groupsHook.loadGroups]);

  // Convert to sidebar format & compute grouped list
  const sidebarSessions = useMemo(
    () => toSidebarSessions(chat.sessions),
    [chat.sessions],
  );
  const groupedEntries = useGroupedSessions(
    sidebarSessions,
    "",
    groupsHook.groups,
  );

  // Filter out group_child entries (they are shown inside group route)
  // In select mode: hide all groups, show only plain sessions
  const listData = useMemo<ListItem[]>(
    () =>
      groupedEntries.filter((e): e is ListItem =>
        isSelectMode
          ? e.type === "session"
          : e.type === "session" || e.type === "group",
      ),
    [groupedEntries, isSelectMode],
  );

  // --- Multi-select helpers ---
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
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
    // Defer tab bar hide to next frame so header updates first
    requestAnimationFrame(() => setTabBarHidden(true));
  }, [setTabBarHidden]);

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
    requestAnimationFrame(() => setTabBarHidden(false));
  }, [setTabBarHidden]);

  const selectedCount = selectedIds.size;
  const hasSelection = selectedCount > 0;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: colors.card,
        },
        contentArea: {
          flex: 1,
        },
        groupRow: {
          flexDirection: "row",
          alignItems: "center",
          minHeight: LIST_ITEM_ESTIMATED_SIZE,
          paddingHorizontal: spacing.md,
          paddingVertical: 10,
          backgroundColor: colors.card,
        },
        groupRowPressed: {
          backgroundColor: colors.secondary,
        },
        avatarCircle: {
          width: 42,
          height: 42,
          borderRadius: 21,
          justifyContent: "center",
          alignItems: "center",
          marginRight: spacing.md,
        },
        avatarManual: {
          backgroundColor: colors.statusIcon.info,
        },
        avatarCron: {
          backgroundColor: colors.warning,
        },
        groupContent: {
          flex: 1,
        },
        groupSeparator: {
          position: "absolute",
          bottom: 0,
          left: spacing.sm + 42 + spacing.md,
          right: 0,
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.border,
        },
        titleRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        },
        groupName: {
          ...typography.body,
          color: colors.foreground,
          fontWeight: "500",
          flex: 1,
          marginRight: spacing.sm,
        },
        groupTime: {
          ...typography.caption,
          color: colors.mutedForeground,
        },
        previewRow: {
          flexDirection: "row",
          alignItems: "center",
          marginTop: 2,
        },
        groupPreview: {
          ...typography.caption,
          color: colors.mutedForeground,
          flex: 1,
          marginRight: spacing.sm,
        },
        groupOwnerName: {
          ...typography.caption,
          color: colors.primary,
          fontWeight: "500",
          marginRight: spacing.sm,
        },
        countBadge: {
          minWidth: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: colors.muted,
          justifyContent: "center",
          alignItems: "center",
          paddingHorizontal: 6,
        },
        countBadgeText: {
          ...typography.caption,
          color: colors.mutedForeground,
          fontWeight: "600",
          fontSize: 11,
        },
        empty: {
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          paddingVertical: 80,
        },
        emptyText: {
          ...typography.body,
          color: colors.mutedForeground,
        },
        // Bottom pill buttons
        bottomPillContainer: {
          position: "absolute",
          bottom: insets.bottom + 8,
          left: spacing.lg,
          right: spacing.lg,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          zIndex: 100,
        },
        pillInner: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          height: 50,
          paddingHorizontal: 22,
          borderRadius: 25,
        },
        pillFallback: {
          backgroundColor: colors.muted,
        },
        pillText: {
          fontSize: 17,
          fontWeight: "600",
        },
        iconPillInner: {
          width: 50,
          height: 50,
          borderRadius: 25,
          alignItems: "center",
          justifyContent: "center",
        },
        headerText: {
          fontSize: 17,
          color: colors.foreground,
        },
      }),
    [colors, insets.top, insets.bottom],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (openSwipeableRef.current) {
        openSwipeableRef.current.close();
        return;
      }
      hapticLight();
      chat.selectSession(sessionId);
      router.push(`/chat/${sessionId}`);
    },
    [chat.selectSession, router],
  );

  const handleNewSession = useCallback(() => {
    hapticLight();
    chat.newSession();
    router.push("/chat/new");
  }, [chat.newSession, router]);

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      hapticWarning();
      Alert.alert(
        isAdminUser ? "移至回收站" : "删除会话",
        isAdminUser
          ? "会话将移至回收站，可随时恢复。"
          : "确定要删除这个会话吗？",
        [
          { text: "取消", style: "cancel" },
          {
            text: isAdminUser ? "移至回收站" : "删除",
            style: "destructive",
            onPress: () => {
              void chat.handleDeleteSession(sessionId);
            },
          },
        ],
      );
    },
    [chat, isAdminUser],
  );

  const handleGroupClick = useCallback(
    (group: SessionGroup) => {
      if (openSwipeableRef.current) {
        openSwipeableRef.current.close();
        return;
      }
      hapticLight();
      router.push(
        `/(tabs)/chat/group/${group.groupKey}?name=${encodeURIComponent(group.name)}`,
      );
    },
    [router],
  );

  const groupMenuSections = useMemo<DropdownSection[]>(() => {
    const sections: DropdownSection[] = [
      {
        id: "create-section",
        actions: [{ id: "__create__", label: "新建分组" }],
      },
    ];
    const items = getSortedGroupItems(
      groupsHook.groups,
      groupsHook.sorting,
      sidebarSessions,
    );
    if (items.length > 0) {
      sections.push({
        id: "groups-section",
        actions: items.map((g) => ({ id: g.id, label: g.name })),
      });
    }
    return sections;
  }, [groupsHook.groups, groupsHook.sorting, sidebarSessions]);

  // Refs: 让 swipe action 回调始终读取最新值，绕过 SessionRow React.memo 阻断
  const groupMenuSectionsRef = useRef(groupMenuSections);
  groupMenuSectionsRef.current = groupMenuSections;
  const createGroupRef = useRef(groupsHook.createGroup);
  createGroupRef.current = groupsHook.createGroup;
  const addSessionsToGroupRef = useRef(groupsHook.addSessionsToGroup);
  addSessionsToGroupRef.current = groupsHook.addSessionsToGroup;

  // --- Batch action handlers ---
  const handleBatchGroupAction = useCallback(
    async (actionId: string) => {
      const ids = [...selectedIds];
      if (ids.length === 0) return;

      if (actionId === "__create__") {
        showTextPrompt({
          title: "新建分组",
          onConfirm: async (name) => {
            const trimmed = name.trim();
            if (trimmed) {
              await groupsHook.createGroup(trimmed, ids);
              exitSelectMode();
              hapticSuccess();
            }
          },
        });
      } else {
        await groupsHook.addSessionsToGroup(actionId, ids);
        exitSelectMode();
        hapticSuccess();
      }
    },
    [selectedIds, groupsHook, exitSelectMode],
  );

  const handleSwipeGroupSelect = useCallback(
    (actionId: string) => {
      if (!swipeGroupSessionId) return;
      if (actionId === "__create__") {
        showTextPrompt({
          title: "新建分组",
          onConfirm: (name) => {
            const trimmed = name.trim();
            if (trimmed)
              void createGroupRef.current(trimmed, [swipeGroupSessionId]);
          },
        });
      } else {
        void addSessionsToGroupRef.current(actionId, [swipeGroupSessionId]);
      }
    },
    [swipeGroupSessionId],
  );

  const handleBatchDelete = useCallback(() => {
    if (!hasSelection) return;
    hapticWarning();

    const ids = [...selectedIds];
    Alert.alert(
      isAdminUser ? "批量移至回收站" : "批量删除",
      `确定要删除 ${ids.length} 个会话吗？`,
      [
        { text: "取消", style: "cancel" },
        {
          text: isAdminUser ? "移至回收站" : "删除",
          style: "destructive",
          onPress: async () => {
            for (const sid of ids) {
              try {
                await authFetch(
                  `/api/sessions/${encodeURIComponent(sid)}?deleteSidecar=true`,
                  {
                    method: "DELETE",
                  },
                );
              } catch {
                /* ignore individual failures */
              }
            }
            await chat.refreshSessions();
            exitSelectMode();
            hapticSuccess();
          },
        },
      ],
    );
  }, [hasSelection, selectedIds, isAdminUser, chat, exitSelectMode]);

  // --- Toggle all ---
  const handleToggleAll = useCallback(() => {
    hapticLight();
    if (selectedIds.size === listData.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(
        new Set(
          listData.map((item) =>
            item.type === "group"
              ? `group-${item.group.groupKey}`
              : item.session.id,
          ),
        ),
      );
    }
  }, [selectedIds.size, listData]);

  const getSessionActions = useCallback(
    (session: ChatSessionIndexItem): SwipeAction[] => {
      const actions: SwipeAction[] = [];
      if (!isReadOnlyGroups) {
        actions.push({
          key: "group",
          label: "分组",
          backgroundColor: colors.actions.organize,
          color: colors.actions.onAction,
          onPress: () => {
            hapticLight();
            setSwipeGroupSessionId(session.id);
            openSwipeableRef.current?.close();
            // Use a small delay to let swipeable close and measure layout
            setTimeout(() => {
              swipeGroupTriggerRef.current?.measureInWindow((_x, y, _w, _h) => {
                setSwipeGroupMenuAnchor(y);
                setSwipeGroupMenuVisible(true);
              });
            }, 100);
          },
        });
      }
      actions.push(
        {
          key: "rename",
          label: "重命名",
          backgroundColor: colors.actions.edit,
          color: colors.actions.onAction,
          onPress: () => {
            hapticLight();
            showTextPrompt({
              title: "重命名",
              defaultValue: session.title || "",
              extraAction: {
                label: "自动",
                onPress: () => {
                  void chat.autoTitleSession(session.id);
                },
              },
              onConfirm: (newTitle) => {
                const trimmed = newTitle.trim();
                if (trimmed) void chat.renameSession(session.id, trimmed);
              },
            });
          },
        },
        {
          key: "delete",
          label: "删除",
          backgroundColor: colors.actions.destructive,
          color: colors.actions.onAction,
          onPress: () => handleDeleteSession(session.id),
        },
      );
      return actions;
    },
    [colors, handleDeleteSession, isReadOnlyGroups, chat.renameSession],
  );

  const showOwner = isAdminUser && chat.ownerFilter === null;

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.type === "group") {
        const latestChild = item.group.children[0];
        return (
          <Pressable
            style={({ pressed }) => [
              styles.groupRow,
              pressed && styles.groupRowPressed,
            ]}
            onPress={() => handleGroupClick(item.group)}
          >
            <View
              style={[
                styles.avatarCircle,
                item.group.kind === "cron"
                  ? styles.avatarCron
                  : styles.avatarManual,
              ]}
            >
              <Ionicons
                name={item.group.kind === "cron" ? "timer" : "folder"}
                size={20}
                color={colors.primaryForeground}
              />
            </View>
            <View style={styles.groupContent}>
              <View style={styles.titleRow}>
                <Text style={styles.groupName} numberOfLines={1}>
                  {item.group.name}
                </Text>
                <Text style={styles.groupTime}>
                  {formatShortDate(item.group.latestUpdatedAt)}
                </Text>
              </View>
              <View style={styles.previewRow}>
                {showOwner && latestChild?.owner && (
                  <Text style={styles.groupOwnerName} numberOfLines={1}>
                    {latestChild.owner.username}
                  </Text>
                )}
                <Text style={styles.groupPreview} numberOfLines={1}>
                  {latestChild?.preview || latestChild?.title || ""}
                </Text>
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{item.group.count}</Text>
                </View>
              </View>
            </View>
            <View style={styles.groupSeparator} />
          </Pressable>
        );
      }

      const ownerUsername =
        item.session.owner?.username || authUser?.username || "";
      const ownerAvatar = avatarMap[ownerUsername];
      return (
        <SessionRow
          session={item.session}
          actions={getSessionActions(item.session)}
          openRowRef={openSwipeableRef}
          onPress={handleSelectSession}
          showOwner={showOwner}
          selectMode={isSelectMode}
          selected={selectedIds.has(item.session.id)}
          onSelectToggle={() => toggleSelect(item.session.id)}
          agentAvatar={ownerAvatar?.avatar}
          agentAvatarVersion={ownerAvatar?.avatarVersion}
          agentAvatarUsername={ownerUsername}
        />
      );
    },
    [
      colors,
      styles,
      handleGroupClick,
      getSessionActions,
      handleSelectSession,
      showOwner,
      isSelectMode,
      selectedIds,
      toggleSelect,
      avatarMap,
      authUser?.username,
    ],
  );

  const keyExtractor = useCallback((item: ListItem) => {
    if (item.type === "group") return `group-${item.group.groupKey}`;
    return item.session.id;
  }, []);

  const getItemType = useCallback((item: ListItem) => item.type, []);

  const renderContent = () => {
    if (chat.isLoadingSessions && chat.sessions.length === 0) {
      return <SkeletonList />;
    }
    return (
      <FlashList
        key={`${isSelectMode ? "select" : "list"}-${chat.sessionsHydrated ? "hydrated" : "cold"}`}
        ref={listRef}
        data={listData}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        drawDistance={250}
        overrideProps={{ initialDrawBatchSize: 12 }}
        onLoad={scrollToTopAfterHydrate}
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
                groupsHook.loadGroups(),
              ]).finally(() => setIsRefreshing(false));
            }}
            tintColor={colors.primary}
          />
        }
        onEndReached={() => {
          if (chat.hasMoreSessions) void chat.loadMoreSessions();
        }}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>暂无会话</Text>
          </View>
        }
      />
    );
  };

  // Whether batch group button should be enabled
  const canBatchGroup = hasSelection && !isReadOnlyGroups;

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Agent SaaS",
          headerLeft: () => (
            <TouchableOpacity
              onPress={isSelectMode ? exitSelectMode : enterSelectMode}
              activeOpacity={0.7}
            >
              <Text style={styles.headerText}>
                {isSelectMode ? "完成" : "选择"}
              </Text>
            </TouchableOpacity>
          ),
          unstable_headerLeftItems: () => [
            glassFree(
              <TouchableOpacity
                onPress={isSelectMode ? exitSelectMode : enterSelectMode}
                activeOpacity={0.7}
              >
                <Text style={styles.headerText}>
                  {isSelectMode ? "完成" : "选择"}
                </Text>
              </TouchableOpacity>,
            ),
          ],
          headerRight: () =>
            isSelectMode ? (
              <TouchableOpacity onPress={handleToggleAll} activeOpacity={0.7}>
                <Text style={styles.headerText}>
                  {selectedIds.size === listData.length && listData.length > 0
                    ? "取消全选"
                    : "全选"}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={handleNewSession} activeOpacity={0.7}>
                <Ionicons name="add" size={24} color={colors.foreground} />
              </TouchableOpacity>
            ),
          unstable_headerRightItems: () =>
            isSelectMode
              ? [
                  glassFree(
                    <TouchableOpacity
                      onPress={handleToggleAll}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.headerText}>
                        {selectedIds.size === listData.length &&
                        listData.length > 0
                          ? "取消全选"
                          : "全选"}
                      </Text>
                    </TouchableOpacity>,
                  ),
                ]
              : [
                  glassFree(
                    <TouchableOpacity
                      onPress={handleNewSession}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name="add"
                        size={24}
                        color={colors.foreground}
                      />
                    </TouchableOpacity>,
                  ),
                ],
        }}
      />
      <View style={styles.contentArea}>{renderContent()}</View>

      {/* Bottom pill buttons in select mode */}
      {isSelectMode && (
        <View style={styles.bottomPillContainer}>
          {renderLeftPill()}
          {renderDeletePill()}
        </View>
      )}

      {/* Hidden ref for swipe group menu anchor measurement */}
      <View
        ref={swipeGroupTriggerRef}
        style={{ position: "absolute", top: 0, left: 0 }}
        collapsable={false}
      />

      {/* Swipe group dropdown menu */}
      <DropdownMenu
        visible={swipeGroupMenuVisible}
        onClose={() => setSwipeGroupMenuVisible(false)}
        sections={groupMenuSectionsRef.current}
        onSelect={handleSwipeGroupSelect}
        anchorTop={swipeGroupMenuAnchor}
      />

      {/* Batch group dropdown menu */}
      <DropdownMenu
        visible={batchGroupMenuVisible}
        onClose={() => setBatchGroupMenuVisible(false)}
        sections={groupMenuSectionsRef.current}
        onSelect={(actionId) => {
          void handleBatchGroupAction(actionId);
        }}
        anchorTop={batchGroupMenuAnchor}
      />
    </View>
  );

  function renderGlass(style: any, children: React.ReactNode) {
    return <View style={[style, styles.pillFallback]}>{children}</View>;
  }

  function renderLeftPill() {
    const label = `分组${hasSelection ? ` (${selectedCount})` : ""}`;
    const content = renderGlass(
      styles.pillInner,
      <>
        <Text style={[styles.pillText, { color: colors.foreground }]}>
          {label}
        </Text>
      </>,
    );

    if (canBatchGroup) {
      return (
        <Pressable
          ref={batchGroupTriggerRef}
          onPress={() => {
            hapticLight();
            batchGroupTriggerRef.current?.measureInWindow((_x, y, _w, h) => {
              setBatchGroupMenuAnchor(y + h);
              setBatchGroupMenuVisible(true);
            });
          }}
        >
          {content}
        </Pressable>
      );
    }
    return content;
  }

  function renderDeletePill() {
    const color = hasSelection ? colors.destructive : colors.foreground;
    return (
      <TouchableOpacity
        onPress={handleBatchDelete}
        disabled={!hasSelection}
        activeOpacity={0.7}
      >
        {renderGlass(
          styles.iconPillInner,
          <Ionicons name="trash" size={24} color={color} />,
        )}
      </TouchableOpacity>
    );
  }
}
