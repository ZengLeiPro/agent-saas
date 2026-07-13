import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Loader2, LogOut, User, ChevronRight, ChevronLeft, FolderClosed, Camera, Lock, Settings2, Users, ShieldCheck, UserCog } from "lucide-react";
import { SwipeableRow } from "@/components/mobile/SwipeableRow";
import type { SwipeAction } from "@/components/mobile/SwipeableRow";
import { PullToRefresh } from "@/components/mobile/PullToRefresh";
import { RenameSessionDialog } from "@/components/chat/RenameSessionDialog";
import { DeleteGroupDialog } from "@/components/chat/DeleteGroupDialog";
import { AddToGroupDialog } from "@/components/chat/AddToGroupDialog";
import { AddSessionsToGroupDialog } from "@/components/chat/AddSessionsToGroupDialog";
import { TrashView } from "@/components/chat/TrashView";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { refreshAll } from "@/lib/refreshBus";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/contexts/AuthContext";
import { TOKEN_KEY } from "@/lib/constants";
import { useGroupedSessions } from "@/hooks/useGroupedSessions";
import { useGroups } from "@/hooks/useGroups";
import { getSortedGroupItems } from "@agent/shared";
import type { ChatSessionIndexItem, AppTab } from "@/types/sidebar";
import type { SettingsSectionId } from "@/types/settings";
import { baseNavItems, formatShortDate, sourceDisplayText } from "@/types/sidebar";
import type { SessionGroup } from "@/types/sessionGroup";
import type { AdminSettingsTarget } from "@/lib/urlSync";
import { DEFAULT_TENANT_ID } from "@agent/shared";

/** 稳定的空集兜底，避免 prop 缺省时每次 render 新建 Set */
const EMPTY_UNREAD_SET: ReadonlySet<string> = new Set();

interface MobileSessionListProps {
  sessions: ChatSessionIndexItem[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onDelete?: (sessionId: string) => void;
  onRename?: (sessionId: string, newTitle: string) => Promise<boolean>;
  onAutoTitle?: (sessionId: string) => Promise<boolean>;
  isLoading?: boolean;
  className?: string;
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
  /** push 版本的 tab 切换，给 user menu 跳转「组织/平台分析」用 */
  onPushTab?: (tab: AppTab) => void;
  onOpenSettings?: (section?: SettingsSectionId) => void;
  /** 打开「组织管理」/「平台管理」modal，并推 URL 到 /tenant-admin/settings 或 /platform-admin/settings */
  onOpenAdminSettings?: (target: AdminSettingsTarget) => void;
  isAdmin?: boolean;
  onClose: () => void;
  renderCronManager?: () => ReactNode;
  renderTenantManager?: () => ReactNode;
  renderTenantAdmin?: () => ReactNode;
  renderPlatformAdmin?: () => ReactNode;
  renderFileBrowser?: () => ReactNode;
  renderCapabilities?: () => ReactNode;
  renderTaskTemplates?: () => ReactNode;
  renderAgentProfile?: () => ReactNode;
  renderSkillManager?: () => ReactNode;
  renderMcpManager?: () => ReactNode;
  renderUsageDashboard?: () => ReactNode;
  renderModelManager?: () => ReactNode;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onLoadGroupSessions?: (groupId: string) => Promise<void>;
  onPreviewTrashSession?: (id: string | null) => void;
  trashPreviewSessionId?: string | null;
  /** 完整未读集（不受分页影响），用于分组折叠行的聚合红点 */
  unreadAiReplySessionIds?: ReadonlySet<string>;
}

export function MobileSessionList({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onAutoTitle,
  isLoading = false,
  className,
  activeTab = "chat",
  onTabChange,
  onPushTab,
  onOpenSettings,
  onOpenAdminSettings,
  isAdmin = false,
  onClose,
  renderCronManager,
  renderTenantManager,
  renderTenantAdmin,
  renderPlatformAdmin,
  renderFileBrowser,
  renderCapabilities,
  renderTaskTemplates,
  renderAgentProfile,
  renderSkillManager,
  renderMcpManager,
  renderUsageDashboard,
  renderModelManager,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onLoadGroupSessions,
  onPreviewTrashSession,
  trashPreviewSessionId,
  unreadAiReplySessionIds,
}: MobileSessionListProps) {
  const { user: authUser, logout, authEnabled, updateAvatar } = useAuth();
  const query = "";
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("avatar", file);
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch("/api/auth/avatar", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert((data as { error?: string }).error || "上传失败");
        return;
      }
      const data = await res.json();
      updateAvatar(data.avatar, data.avatarVersion);
    } catch {
      alert("上传失败");
    }
    e.target.value = "";
  }, [updateAvatar]);
  const [swipeOpenId, setSwipeOpenId] = useState<string | null>(null);
  const swipeOpenIdRef = useRef(swipeOpenId);
  swipeOpenIdRef.current = swipeOpenId;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const swipeDismissedAt = useRef(0);

  // 重命名弹窗状态
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);

  // 分组重命名/删除状态
  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null);

  // 无限滚动
  const mobileScrollAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const el = mobileScrollAreaRef.current;
    if (!el) return;
    const viewport = el.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement | null;
    if (!viewport) return;
    const onScroll = () => {
      if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 200) {
        onLoadMore();
      }
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [onLoadMore, hasMore]);

  // 分组展开状态
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);

  const groupsHook = useGroups();
  // 所有用户都只看自己的会话，分组始终可编辑
  const isReadOnlyGroups = false;

  // 分组数据
  const groupedEntries = useGroupedSessions(sessions, query, groupsHook.groups);

  // 分组折叠行的聚合未读红点：基于「完整未读集 ∩ 分组成员全集」，不受会话分页影响，
  // 因此能反映组内分页外会话的未读。（分组行本身在组内会话全未加载时不渲染，属既有限制）
  const unreadSet = unreadAiReplySessionIds ?? EMPTY_UNREAD_SET;
  const unreadByGroupId = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const g of groupsHook.groups) {
      map.set(g.id, g.sessionIds.some(id => unreadSet.has(id)));
    }
    return map;
  }, [groupsHook.groups, unreadSet]);

  // 展开的分组对象
  const expandedGroup = useMemo<SessionGroup | null>(() => {
    if (!expandedGroupKey) return null;
    for (const e of groupedEntries) {
      if (e.type === "group" && e.group.groupKey === expandedGroupKey) return e.group;
    }
    return null;
  }, [expandedGroupKey, groupedEntries]);

  // 初始化时：如果当前会话在某个分组中，自动展开
  const initialExpandDone = useRef(false);
  useEffect(() => {
    if (initialExpandDone.current || !activeSessionId || groupedEntries.length === 0) return;
    initialExpandDone.current = true;
    for (const entry of groupedEntries) {
      if (entry.type === "group" && entry.group.children.some((c) => c.id === activeSessionId)) {
        setExpandedGroupKey(entry.group.groupKey);
        return;
      }
    }
  }, [activeSessionId, groupedEntries]);

  // 包装 setSwipeOpenId：当从打开变为关闭时记录时间戳
  const handleSwipeOpenChange = useCallback((id: string | null) => {
    if (!id && swipeOpenIdRef.current) {
      swipeDismissedAt.current = Date.now();
    }
    setSwipeOpenId(id);
  }, []);

  // 有行刚收回时（300ms 内），点击任意位置不执行选择
  const handleSelect = useCallback(
    (id: string) => {
      if (isLoading && !activeSessionIdRef.current) return;
      if (swipeOpenIdRef.current) {
        setSwipeOpenId(null);
        return;
      }
      if (Date.now() - swipeDismissedAt.current < 300) {
        return;
      }
      onSelect(id);
    },
    [isLoading, onSelect],
  );

  // 点击分组（带防误触）
  const handleGroupClick = useCallback(
    (groupKey: string) => {
      if (swipeOpenIdRef.current) {
        setSwipeOpenId(null);
        return;
      }
      if (Date.now() - swipeDismissedAt.current < 300) {
        return;
      }
      setExpandedGroupKey(groupKey);
      onLoadGroupSessions?.(groupKey);
    },
    [onLoadGroupSessions],
  );

  useEffect(() => {
    if (!showUserMenu) return;
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showUserMenu]);


  const navItems = useMemo(
    () => [
      ...baseNavItems.filter((item) => !item.adminOnly || isAdmin),
      { tab: "capabilities" as AppTab, label: "专家与能力" },
      ...(renderTaskTemplates ? [{ tab: "scenarios" as AppTab, label: "任务模板" }] : []),
    ],
    [isAdmin, renderTaskTemplates],
  );

  // 打开重命名弹窗
  const openRenameDialog = useCallback((sessionId: string) => {
    setRenameSessionId(sessionId);
  }, []);

  // --- 分组操作 ---
  const [addToGroupSessionId, setAddToGroupSessionId] = useState<string | null>(null);
  const [addSessionsGroupKey, setAddSessionsGroupKey] = useState<string | null>(null);

  // 使用 getSortedGroupItems 统一排序，与所有分组选择入口一致
  const allGroups = useMemo<SessionGroup[]>(() => {
    return getSortedGroupItems(groupsHook.groups, groupsHook.sorting, sessions).map((g) => ({
      groupKey: g.id,
      name: g.name,
      kind: g.kind,
      children: [],
      latestUpdatedAt: g.updatedAt,
      count: g.count,
    }));
  }, [groupsHook.groups, groupsHook.sorting, sessions]);

  const handleAddToExistingGroup = useCallback(async (groupKey: string) => {
    if (!addToGroupSessionId) return;
    await groupsHook.addSessionsToGroup(groupKey, [addToGroupSessionId]);
    setAddToGroupSessionId(null);
  }, [addToGroupSessionId, groupsHook]);

  const handleCreateGroupAndAdd = useCallback(async (groupName: string) => {
    if (!addToGroupSessionId) return;
    await groupsHook.createGroup(groupName, [addToGroupSessionId]);
    setAddToGroupSessionId(null);
  }, [addToGroupSessionId, groupsHook]);

  const handleAddSessionsToGroup = useCallback(async (sessionIds: string[]) => {
    if (!addSessionsGroupKey || !expandedGroup) return;
    await groupsHook.addSessionsToGroup(addSessionsGroupKey, sessionIds);
    setAddSessionsGroupKey(null);
  }, [addSessionsGroupKey, expandedGroup, groupsHook]);

  const handleRemoveFromGroup = useCallback(async (sessionId: string) => {
    if (!expandedGroup) return;
    await groupsHook.removeSessionsFromGroup(expandedGroup.groupKey, [sessionId]);
  }, [expandedGroup, groupsHook]);

  // 分组重命名
  const handleRenameGroup = useCallback(async (newName: string): Promise<boolean> => {
    if (!renameGroupId) return false;
    await groupsHook.renameGroup(renameGroupId, newName);
    return true;
  }, [renameGroupId, groupsHook]);

  // 分组删除
  const handleDeleteGroup = useCallback(() => {
    if (!deleteGroupId) return;
    if (expandedGroupKey === deleteGroupId) setExpandedGroupKey(null);
    groupsHook.deleteGroup(deleteGroupId);
    setDeleteGroupId(null);
  }, [deleteGroupId, expandedGroupKey, groupsHook]);

  // 渲染单个会话行
  const renderSessionRow = useCallback(
    (s: ChatSessionIndexItem, inGroup?: boolean) => {
      const active = s.id === activeSessionIdRef.current;
      const rowContent = (
        <div
          className={cn(
            "group relative cursor-pointer rounded-lg px-3 py-3 transition-colors",
            active ? "bg-accent" : "hover:bg-muted",
          )}
          onClick={() => handleSelect(s.id)}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center text-sm font-medium leading-snug">
              {s.hasUnreadAiReply && (
                <span className="mr-1 flex w-4 shrink-0 items-center justify-center" aria-hidden="true">
                  <span className="h-2 w-2 rounded-full bg-destructive" />
                </span>
              )}
              <span className="truncate">{s.title || "新会话"}</span>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">
              {formatShortDate(s.updatedAt)}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground/60">
            <span>{sourceDisplayText(s.source)}</span>
            {s.orgAgentName && <span> · {s.orgAgentName}</span>}
            {isAdmin && s.owner && (
              <span> - {s.owner.realName || s.owner.username}</span>
            )}
          </div>
        </div>
      );

      if (onDelete) {
        const actions: SwipeAction[] = [];
        if (!isReadOnlyGroups) {
          actions.push({
            key: "group",
            label: "分组",
            className: "bg-foreground text-background",
            onClick: () => setAddToGroupSessionId(s.id),
          });
        }
        if (onRename) {
          actions.push({
            key: "rename",
            label: "重命名",
            className: "bg-primary text-primary-foreground",
            onClick: () => openRenameDialog(s.id),
          });
        }
        if (onAutoTitle) {
          actions.push({
            key: "autoTitle",
            label: "AI命名",
            className: "bg-primary text-primary-foreground",
            onClick: () => onAutoTitle(s.id),
          });
        }
        if (inGroup && !isReadOnlyGroups) {
          actions.push({
            key: "ungroup",
            label: "移出",
            className: "bg-warning text-warning-foreground",
            onClick: () => handleRemoveFromGroup(s.id),
          });
        }
        actions.push({
          key: "delete",
          label: "删除",
          className: "bg-destructive text-destructive-foreground",
          onClick: () => onDelete(s.id),
        });

        return (
          <SwipeableRow
            key={s.id}
            rowId={s.id}
            openId={swipeOpenIdRef.current}
            onOpenChange={handleSwipeOpenChange}
            actions={actions}
            disabled={isLoading}
          >
            {rowContent}
          </SwipeableRow>
        );
      }

      return <div key={s.id}>{rowContent}</div>;
    },
    [handleSelect, isAdmin, isLoading, onDelete, onRename, onAutoTitle, openRenameDialog, handleSwipeOpenChange, handleRemoveFromGroup, isReadOnlyGroups],
  );

  // 渲染分组行
  const renderGroupRow = useCallback(
    (group: SessionGroup) => {
      const groupRowId = `group:${group.groupKey}`;
      const rowContent = (
        <div
          className={cn(
            "group relative cursor-pointer rounded-lg px-3 py-3 transition-colors",
            expandedGroupKey === group.groupKey ? "bg-accent" : "hover:bg-muted",
          )}
          onClick={() => handleGroupClick(group.groupKey)}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <FolderClosed className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="truncate text-sm font-medium leading-snug">{group.name}</span>
              {unreadByGroupId.get(group.groupKey) && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
              )}
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">
              {formatShortDate(group.latestUpdatedAt)}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground/60">
            {group.kind === "cron" ? "cron" : "分组"} - {group.count} 个会话
          </div>
        </div>
      );

      if (!isReadOnlyGroups) {
        const actions: SwipeAction[] = [
          {
            key: "rename",
            label: "重命名",
            className: "bg-primary text-primary-foreground",
            onClick: () => setRenameGroupId(group.groupKey),
          },
          {
            key: "delete",
            label: "删除",
            className: "bg-destructive text-destructive-foreground",
            onClick: () => setDeleteGroupId(group.groupKey),
          },
        ];
        return (
          <SwipeableRow
            key={`group-${group.groupKey}`}
            rowId={groupRowId}
            actions={actions}
            openId={swipeOpenIdRef.current}
            onOpenChange={handleSwipeOpenChange}
          >
            {rowContent}
          </SwipeableRow>
        );
      }

      return <div key={`group-${group.groupKey}`}>{rowContent}</div>;
    },
    [expandedGroupKey, handleGroupClick, isReadOnlyGroups, handleSwipeOpenChange, unreadByGroupId],
  );

  // 当前是否在分组详情视图
  const isInGroupView = expandedGroupKey !== null && expandedGroup !== null;

  // 双面板滑动容器和面板 refs（用于手势跟手）
  const slidingContainerRef = useRef<HTMLDivElement>(null);
  const mainPanelRef = useRef<HTMLDivElement>(null);
  const groupPanelRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(isInGroupView);
  expandedRef.current = isInGroupView;

  // 分组面板左侧边缘右滑返回手势
  useEffect(() => {
    const container = slidingContainerRef.current;
    if (!container) return;

    const EDGE_WIDTH = 44;
    const LOCK_THRESHOLD = 8;
    const SWIPE_THRESHOLD = 0.2;
    const VELOCITY_THRESHOLD = 0.3;
    const ANIM = "350ms cubic-bezier(.25,.1,.25,1)";

    let startX = 0;
    let startY = 0;
    let prevX = 0;
    let prevTime = 0;
    let tracking = false;
    let dirLocked: "h" | "v" | null = null;
    let width = 0;

    function applySwipeTransform(progress: number, animate: boolean) {
      const m = mainPanelRef.current;
      const g = groupPanelRef.current;
      if (!m || !g) return;
      const t = animate ? `transform ${ANIM}` : "none";
      m.style.transition = t;
      g.style.transition = t;
      m.style.transform = `translateX(${(-100 + progress * 100)}%)`;
      g.style.transform = `translateX(${(progress * 100)}%)`;
    }

    function onTouchStart(e: TouchEvent) {
      if (!expandedRef.current) return;
      const touch = e.touches[0];
      if (touch.clientX > EDGE_WIDTH) return;

      width = container!.clientWidth;
      startX = touch.clientX;
      startY = touch.clientY;
      prevX = startX;
      prevTime = e.timeStamp;
      tracking = true;
      dirLocked = null;
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!dirLocked) {
        if (Math.abs(dx) < LOCK_THRESHOLD && Math.abs(dy) < LOCK_THRESHOLD) return;
        dirLocked = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      }
      if (dirLocked === "v") { tracking = false; return; }
      if (dx <= 0) return;

      e.preventDefault();
      prevX = touch.clientX;
      prevTime = e.timeStamp;

      const progress = Math.min(1, dx / width);
      applySwipeTransform(progress, false);
    }

    function onTouchEnd(e: TouchEvent) {
      if (!tracking) return;
      tracking = false;

      const g = groupPanelRef.current;
      if (!g || !width) return;

      const dt = e.timeStamp - prevTime || 1;
      const velocity = (prevX - startX) / dt;

      const matrix = new DOMMatrixReadOnly(getComputedStyle(g).transform);
      const progress = matrix.m41 / width;

      if (progress > SWIPE_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
        applySwipeTransform(1, true);
        setExpandedGroupKey(null);
      } else {
        applySwipeTransform(0, true);
      }
    }

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  return (
    <aside className={cn("relative flex h-full w-72 shrink-0 flex-col bg-card", className)}>
      {/* Header: 移动端全屏时补偿 safe-area-top */}
      <div className="flex items-center justify-between px-4 py-3" style={{ paddingTop: "calc(var(--sat) + 0.75rem)" }}>
        {isInGroupView && expandedGroup ? (
          <>
            {/* Left: 返回箭头 */}
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-full transition-opacity hover:bg-accent active:opacity-70"
              onClick={() => setExpandedGroupKey(null)}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            {/* Center: 分组名 */}
            <div className="min-w-0 text-center">
              <div className="truncate text-base font-semibold">{expandedGroup.name}</div>
              <div className="text-xs text-muted-foreground">{expandedGroup.count} 个会话</div>
            </div>
            {/* Right: 添加按钮 - 只读模式下隐藏 */}
            {isReadOnlyGroups ? (
              <div className="w-8" />
            ) : (
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-full transition-opacity hover:bg-accent active:opacity-70"
                onClick={() => setAddSessionsGroupKey(expandedGroup.groupKey)}
              >
                <Plus className="h-5 w-5" />
              </button>
            )}
          </>
        ) : (
          <>
            {/* Left: avatar */}
            <div className="relative flex items-center" ref={userMenuRef}>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-full transition-opacity active:opacity-70"
                onClick={() => authEnabled && authUser && setShowUserMenu((v) => !v)}
              >
                {authUser ? (
                  authUser.avatar ? (
                    <img src={authUser.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                      {authUser.username.charAt(0).toUpperCase()}
                    </div>
                  )
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                    <User className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
              </button>
              <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleAvatarUpload} />
              {showUserMenu && authEnabled && authUser && (
                <div className="absolute left-0 top-10 z-50 min-w-[160px] rounded-lg border bg-popover py-1 shadow-md">
                  <div className="px-3 py-2 text-xs text-muted-foreground border-b truncate">{authUser.username}</div>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                    onClick={() => { setShowUserMenu(false); onClose(); onOpenSettings?.("account"); }}
                  >
                    <UserCog className="h-3.5 w-3.5" />
                    账户设置
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                    onClick={() => { setShowUserMenu(false); avatarInputRef.current?.click(); }}
                  >
                    <Camera className="h-3.5 w-3.5" />
                    更换头像
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                    onClick={() => { setShowUserMenu(false); setShowPasswordDialog(true); }}
                  >
                    <Lock className="h-3.5 w-3.5" />
                    修改密码
                  </button>

                  {authUser.role === "admin" && (
                    <>
                      <div className="my-1 border-t" />
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                        onClick={() => { setShowUserMenu(false); onClose(); (onPushTab ?? onTabChange)?.("tenant-admin"); }}
                      >
                        <Users className="h-3.5 w-3.5" />
                        组织分析
                      </button>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                        onClick={() => { setShowUserMenu(false); onClose(); onOpenAdminSettings?.("tenant"); }}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                        组织管理
                      </button>
                    </>
                  )}
                  {authUser.role === "admin" && authUser.tenantId === DEFAULT_TENANT_ID && (
                    <>
                      <div className="my-1 border-t" />
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                        onClick={() => { setShowUserMenu(false); onClose(); (onPushTab ?? onTabChange)?.("platform-admin"); }}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        平台分析
                      </button>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                        onClick={() => { setShowUserMenu(false); onClose(); onOpenAdminSettings?.("platform"); }}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                        平台管理
                      </button>
                    </>
                  )}
                  <div className="my-1 border-t" />
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                    onClick={() => { setShowUserMenu(false); logout(); }}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    退出登录
                  </button>
                </div>
              )}
            </div>
            {/* Center: brand */}
            <div className="text-base font-semibold">KY Agent</div>
            {/* Right: close arrow */}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={onClose}
              >
                <ChevronRight className="!h-6 !w-6" />
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Pill tabs + tab content: PullToRefresh 包裹，内部双面板滑动 */}
      <PullToRefresh onRefresh={refreshAll}>
        <div ref={slidingContainerRef} className="relative flex min-h-0 flex-1 overflow-hidden">
          {/* 主面板：tabs + 列表 */}
          <div
            ref={mainPanelRef}
            className="absolute inset-0 flex flex-col"
            style={{
              transform: isInGroupView ? "translateX(-100%)" : "translateX(0)",
              transition: "transform 350ms cubic-bezier(.25,.1,.25,1)",
            }}
          >
            {/* Pill tabs */}
            {onTabChange && (
              <nav className="px-4 pb-3">
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {navItems.map(({ tab, label }) => (
                    <button
                      key={tab}
                      type="button"
                      className={cn(
                        "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                        activeTab === tab && !showTrash
                          ? "bg-foreground text-background"
                          : "border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                      onClick={() => { onTabChange(tab); setShowTrash(false); }}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={cn(
                      "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                      activeTab === "files" && !showTrash
                        ? "bg-foreground text-background"
                        : "border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                    onClick={() => { onTabChange?.("files"); setShowTrash(false); }}
                  >
                    文件
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                      showTrash
                        ? "bg-foreground text-background"
                        : "border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                    onClick={() => { setShowTrash(v => { if (v) onPreviewTrashSession?.(null); return !v; }); if (onTabChange) onTabChange("chat"); }}
                  >
                    回收站
                  </button>
                </div>
              </nav>
            )}

            {/* 回收站视图（所有用户可见，owner-self only） */}
            {showTrash ? (
              <TrashView
                onClose={() => { setShowTrash(false); onPreviewTrashSession?.(null); }}
                onPreviewSession={(id) => onPreviewTrashSession?.(id)}
                activePreviewId={trashPreviewSessionId}
              />
            ) : (<>

            {/* Chat tab */}
            <div className={cn("flex min-h-0 flex-1 flex-col", activeTab !== "chat" && "hidden")}>
              <ScrollArea ref={mobileScrollAreaRef} className="flex-1 [&_[style*=table]]:!block">
                <div className="px-2 py-1 pb-24">
                  {isLoading && groupedEntries.length === 0 ? (
                    <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      加载中...
                    </div>
                  ) : groupedEntries.length === 0 ? (
                    <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                      暂无会话
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {groupedEntries.map((entry) => {
                        if (entry.type === "group") {
                          return renderGroupRow(entry.group);
                        }
                        return renderSessionRow(entry.session);
                      })}
                    </div>
                  )}
                  {isLoadingMore && (
                    <div className="flex items-center justify-center py-3 text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    </div>
                  )}
                  {!hasMore && sessions.length > 0 && !isLoading && (
                    <div className="py-3 text-center text-xs text-muted-foreground/40">
                      没有更多了
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>

            {renderCapabilities && (
              <div className={cn("min-h-0 flex-1 overflow-hidden", activeTab !== "capabilities" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderCapabilities()}
              </div>
            )}

            {renderTaskTemplates && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "scenarios" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderTaskTemplates()}
              </div>
            )}

            {/* Cron tab */}
            {renderCronManager && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "cron" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderCronManager()}
              </div>
            )}

            {/* Tenants tab */}
            {renderTenantManager && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "tenants" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderTenantManager()}
              </div>
            )}


            {/* Tenant Admin shell */}
            {renderTenantAdmin && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "tenant-admin" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderTenantAdmin()}
              </div>
            )}

            {/* Platform Admin shell */}
            {renderPlatformAdmin && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "platform-admin" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderPlatformAdmin()}
              </div>
            )}
            {/* Files tab */}
            {renderFileBrowser && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "files" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderFileBrowser()}
              </div>
            )}

            {/* Agent Profile tab */}
            {renderAgentProfile && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "profile" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderAgentProfile()}
              </div>
            )}

            {/* Skills tab */}
            {renderSkillManager && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "skills" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderSkillManager()}
              </div>
            )}

            {/* MCP tab */}
            {renderMcpManager && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "mcp" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderMcpManager()}
              </div>
            )}

            {/* Usage tab */}
            {renderUsageDashboard && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "usage" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderUsageDashboard()}
              </div>
            )}

            {/* Models tab */}
            {renderModelManager && (
              <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "models" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
                {renderModelManager()}
              </div>
            )}

            {/* Trash tab */}
            <div className={cn("min-h-0 flex-1 overflow-auto", activeTab !== "trash" && "hidden")} style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
              <TrashView
                onClose={() => onTabChange?.("chat")}
                onPreviewSession={(id) => onPreviewTrashSession?.(id)}
                activePreviewId={trashPreviewSessionId}
              />
            </div>

            </>)}
          </div>

          {/* 分组详情面板：子会话列表 */}
          <div
            ref={groupPanelRef}
            className="absolute inset-0 flex flex-col"
            style={{
              transform: isInGroupView ? "translateX(0)" : "translateX(100%)",
              transition: "transform 350ms cubic-bezier(.25,.1,.25,1)",
            }}
          >
            {expandedGroup && (
              <ScrollArea className="flex-1 [&_[style*=table]]:!block">
                <div className="px-2 py-1 pb-24">
                  <div className="flex flex-col gap-1">
                    {expandedGroup.children.map((s) => renderSessionRow(s, true))}
                  </div>
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
      </PullToRefresh>

      {/* FAB - new session（分组详情视图时隐藏） */}
      {activeTab === "chat" && !isInGroupView && (
        <button
          type="button"
          onClick={onNew}
          disabled={isLoading}
          className="absolute right-4 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95 disabled:opacity-50"
          style={{ bottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <Plus className="h-6 w-6" />
        </button>
      )}

      {/* 重命名弹窗 */}
      {onRename && (
        <RenameSessionDialog
          open={renameSessionId !== null}
          initialTitle={sessions.find((s) => s.id === renameSessionId)?.title || ""}
          onOpenChange={(open) => { if (!open) setRenameSessionId(null); }}
          onConfirm={(newTitle) => onRename(renameSessionId!, newTitle)}
        />
      )}

      {/* 分组重命名弹窗 */}
      <RenameSessionDialog
        open={renameGroupId !== null}
        initialTitle={groupsHook.groups.find((g) => g.id === renameGroupId)?.name ?? ""}
        dialogTitle="重命名分组"
        dialogDescription={
          groupsHook.groups.find((g) => g.id === renameGroupId)?.kind === "cron"
            ? "输入新的分组名称。注意：此分组关联定时任务，下次执行时名称可能被自动覆盖。"
            : "输入新的分组名称"
        }
        placeholder="分组名称"
        onOpenChange={(open) => { if (!open) setRenameGroupId(null); }}
        onConfirm={handleRenameGroup}
      />

      {/* 分组删除确认 */}
      <DeleteGroupDialog
        open={deleteGroupId !== null}
        isCron={groupsHook.groups.find((g) => g.id === deleteGroupId)?.kind === "cron"}
        onOpenChange={(open) => { if (!open) setDeleteGroupId(null); }}
        onConfirm={handleDeleteGroup}
      />

      {/* 添加到分组弹窗 */}
      <AddToGroupDialog
        open={addToGroupSessionId !== null}
        onOpenChange={(open) => { if (!open) setAddToGroupSessionId(null); }}
        allGroups={allGroups}

        onAddToExistingGroup={handleAddToExistingGroup}
        onCreateGroupAndAdd={handleCreateGroupAndAdd}
      />

      {/* 添加会话到分组弹窗 */}
      <AddSessionsToGroupDialog
        open={addSessionsGroupKey !== null}
        onOpenChange={(open) => { if (!open) setAddSessionsGroupKey(null); }}
        allSessions={sessions}
        existingSessionIds={
          addSessionsGroupKey && expandedGroup
            ? new Set(expandedGroup.children.map((c) => c.id))
            : new Set()
        }
        onConfirm={handleAddSessionsToGroup}
      />

      {/* 修改密码弹窗 */}
      <ChangePasswordDialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog} />
    </aside>
  );
}
