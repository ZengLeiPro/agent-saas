import { useCallback, useMemo, useRef, useState, useEffect, type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import {
  Plus,
  MoreHorizontal,
  MessageSquare,
  Pencil,
  Sparkles,
  Bot,
  Trash2,
  Loader2,
  LogOut,
  User,
  Folder,
  FolderPlus,
  ChevronLeft,
  ChevronRight,
  FolderMinus,
  Camera,
  Check,
  Lock,
  RefreshCw,
  Clock,
  Plug,
  Minimize2,
  Settings2,
  GripVertical,
  X,
  ChevronsUpDown,
  Building2,
  ShieldCheck,
  UserCog,
  Search,
  LayoutGrid,
} from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { RenameSessionDialog } from "@/components/chat/RenameSessionDialog";
import { DeleteGroupDialog } from "@/components/chat/DeleteGroupDialog";
import { AddToGroupDialog } from "@/components/chat/AddToGroupDialog";
import { AddSessionsToGroupDialog } from "@/components/chat/AddSessionsToGroupDialog";
import { TrashView } from "@/components/chat/TrashView";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { SessionSearchResults } from "@/components/chat/SessionSearchResults";
import {
  matchRoleIdByPosition,
  useScenarioLibrary,
} from "@/components/scenarios/useScenarioLibrary";
import { useRoleKitConfig } from "@/components/scenarios/useRoleKitConfig";

import { refreshAll } from "@/lib/refreshBus";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/contexts/AuthContext";
import type { AuthUser } from "@/types/auth";
import { TOKEN_KEY } from "@/lib/constants";
import { useGroups } from "@/hooks/useGroups";
import {
  applyGroupOrder,
} from "@agent/shared";
import { useResizableWidth } from "@/hooks/useResizableWidth";
import { useSessionSearch } from "@/hooks/useSessionSearch";
import type { ChatSessionIndexItem, AppTab } from "@/types/sidebar";
import type { SettingsSectionId } from "@/types/settings";
import { baseNavItems, formatShortDate } from "@/types/sidebar";
import type { SessionGroup, SessionListEntry } from "@/types/sessionGroup";
import type { AdminSettingsTarget } from "@/lib/urlSync";

interface DesktopSessionSidebarProps {
  sessions: ChatSessionIndexItem[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onDelete?: (sessionId: string) => void;
  onDeleteMany?: (sessionIds: string[]) => void;
  onRename?: (sessionId: string, newTitle: string) => Promise<boolean>;
  onAutoTitle?: (sessionId: string) => Promise<boolean>;
  onCompact?: () => Promise<void>;
  isLoading?: boolean;
  className?: string;
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
  /** push 版本的 tab 切换：用于 user menu 跳转到「组织/平台分析」，浏览器后退可回到原页面 */
  onPushTab?: (tab: AppTab) => void;
  onOpenSettings?: (section?: SettingsSectionId) => void;
  /** 打开「组织管理」/「平台管理」modal，并把 URL 推到 /tenant-admin/settings 或 /platform-admin/settings */
  onOpenAdminSettings?: (target: AdminSettingsTarget) => void;
  isAdmin?: boolean;
  /** 平台 admin（跨组织管理者）。组织管理入口对 admin 可见，平台管理入口仅平台 admin 可见。 */
  isPlatformAdmin?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onLoadGroupSessions?: (groupId: string) => Promise<void>;
  hidden?: boolean;
  onPreviewTrashSession?: (id: string | null) => void;
  trashPreviewSessionId?: string | null;
  /** 完整未读集（不受分页影响），用于左栏各视图/分组的聚合红点 */
  unreadAiReplySessionIds?: ReadonlySet<string>;
  sidebarLayout?: "double" | "single";
}

/** 稳定的空集兜底，避免 prop 缺省时每次 render 新建 Set 触发 useMemo 失效 */
const EMPTY_UNREAD_SET: ReadonlySet<string> = new Set();

// 侧边栏导航/分组的选中态：左侧 brand-accent rail + 暖橙浅底 + 字加粗。
// 与上方「新建会话」brand-100 CTA 的语言彻底脱钩：颜色管动作，形态（rail）管状态。
const NAV_ITEM_SELECTED =
  "relative bg-brand-accent-soft text-foreground font-semibold " +
  "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 " +
  "before:h-5 before:w-[3px] before:rounded-r-full before:bg-brand-accent";
const NAV_ITEM_UNSELECTED =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

const USER_MENU_ITEM =
  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent";
const USER_MENU_SECTION = "border-t border-border/60 py-1 first:border-t-0";

/** 左栏视图/分组标签上的聚合未读小红点 */
function GroupUnreadDot() {
  return (
    <span
      className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
      aria-hidden="true"
    />
  );
}

/* ------------------------------------------------------------------ */
/*  SessionRow: 复用的会话行                                           */
/* ------------------------------------------------------------------ */
function SessionLeadingIcon({ session, selected = false }: { session: ChatSessionIndexItem; selected?: boolean }) {
  if (selected) {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white" aria-hidden="true">
        <Check className="h-5 w-5 stroke-[3]" />
      </span>
    );
  }

  return (
    <AgentAvatar
      avatar={session.agent?.avatar}
      username={session.agent?.username}
      size={40}
      className="bg-muted text-muted-foreground"
      version={session.agent?.avatarVersion}
    />
  );
}

/** 紧凑模式（不显示头像）下的会话前缀小图标：普通会话=灰色气泡；批量选中态=绿色小勾。 */
function CompactSessionLeadingIcon({ selected = false }: { selected?: boolean }) {
  if (selected) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white" aria-hidden="true">
        <Check className="h-3 w-3 stroke-[3]" />
      </span>
    );
  }
  return <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />;
}

/** 紧凑模式下的分组前缀小图标：保留分组语义，但用浅品牌色降低视觉重量。 */
function CompactGroupLeadingIcon({ kind }: { kind: SessionGroup["kind"] }) {
  if (kind === "cron") {
    return <Clock className="h-4 w-4 shrink-0 text-teal-600/70 dark:text-teal-300/70" aria-hidden="true" />;
  }

  return (
    <Folder
      className="h-4 w-4 shrink-0 fill-brand-100 text-brand-500/80 dark:fill-brand-900/35 dark:text-brand-300/80"
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}

function GroupLeadingIcon({ kind }: { kind: SessionGroup["kind"] }) {
  const Icon = kind === "cron" ? Clock : FolderPlus;

  return (
    <span
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full ring-1",
        kind === "cron"
          ? "bg-teal-50 text-teal-600 ring-teal-100 dark:bg-teal-700/20 dark:text-teal-300 dark:ring-teal-600/30"
          : "bg-brand-50 text-brand-600 ring-brand-100 dark:bg-brand-900/35 dark:text-brand-300 dark:ring-brand-800",
      )}
      aria-hidden="true"
    >
      <Icon className="h-5 w-5" />
    </span>
  );
}

function SessionRow({
  session,
  active,
  metaText,
  isLoading,
  onSelect,
  onDelete,
  onRename,
  onAutoTitle,
  actionMenuId,
  setActionMenuId,
  actionMenuRef,
  setRenameSessionId,
  onAddToGroup,
  onRemoveFromGroup,
  isInManualGroup,
  onCompact,
  selectionMode = false,
  selected = false,
  singleColumn = false,
  compact = false,
}: {
  session: ChatSessionIndexItem;
  active: boolean;
  metaText?: string;
  isLoading: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (sessionId: string, newTitle: string) => Promise<boolean>;
  onAutoTitle?: (sessionId: string) => Promise<boolean>;
  actionMenuId: string | null;
  setActionMenuId: (id: string | null) => void;
  actionMenuRef: React.RefObject<HTMLDivElement>;
  setRenameSessionId: (id: string | null) => void;
  onAddToGroup?: (sessionId: string) => void;
  onRemoveFromGroup?: (sessionId: string) => void;
  isInManualGroup?: boolean;
  onCompact?: () => void;
  selectionMode?: boolean;
  selected?: boolean;
  singleColumn?: boolean;
  /** 紧凑模式（不显示头像）：单行布局，行尾日期 hover 时切换为更多按钮。 */
  compact?: boolean;
}) {
  const menuOpen = actionMenuId === session.id;
  const hasMenu = !selectionMode && Boolean(onDelete || onRename || onAddToGroup);

  const menuDropdown = menuOpen ? (
    <div className="absolute right-0 top-full z-50 mt-1 min-w-[120px] rounded-lg border bg-popover py-1 shadow-md">
      {onRename && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            setActionMenuId(null);
            setRenameSessionId(session.id);
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
          重命名
        </button>
      )}
      {onAutoTitle && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            setActionMenuId(null);
            onAutoTitle(session.id);
          }}
        >
          <Sparkles className="h-3.5 w-3.5" />
          自动命名
        </button>
      )}
      {onAddToGroup && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            setActionMenuId(null);
            onAddToGroup(session.id);
          }}
        >
          <FolderPlus className="h-3.5 w-3.5" />
          添加到分组
        </button>
      )}
      {isInManualGroup && onRemoveFromGroup && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            setActionMenuId(null);
            onRemoveFromGroup(session.id);
          }}
        >
          <FolderMinus className="h-3.5 w-3.5" />
          移出分组
        </button>
      )}
      {onCompact && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            setActionMenuId(null);
            onCompact();
          }}
        >
          <Minimize2 className="h-3.5 w-3.5" />
          压缩上下文
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            setActionMenuId(null);
            onDelete(session.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </button>
      )}
    </div>
  ) : null;

  if (compact) {
    return (
      <div
        className={cn(
          "group relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors",
          active
            ? "bg-brand-accent-soft before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-r-full before:bg-brand-accent"
            : "hover:bg-muted",
          menuOpen && "z-10",
        )}
        onClick={() => onSelect(session.id)}
      >
        <CompactSessionLeadingIcon selected={selected} />
        {session.hasUnreadAiReply && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5">
          {session.title || "新会话"}
        </span>
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground/60 transition-opacity",
            hasMenu && "group-hover:opacity-0",
            hasMenu && menuOpen && "opacity-0",
          )}
        >
          {formatShortDate(session.updatedAt)}
        </span>
        {hasMenu && (
          <div
            className={cn(
              "absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
              menuOpen && "opacity-100",
            )}
            ref={menuOpen ? actionMenuRef : undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={(e) => {
                e.stopPropagation();
                setActionMenuId(menuOpen ? null : session.id);
              }}
              disabled={isLoading}
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
            {menuDropdown}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative cursor-pointer rounded-lg px-3 py-3 transition-colors",
        active
          ? "bg-brand-accent-soft before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-r-full before:bg-brand-accent"
          : "hover:bg-muted",
        menuOpen && "z-10",
      )}
      onClick={() => onSelect(session.id)}
    >
      <div className="flex min-w-0 items-center gap-3 pr-8">
        <SessionLeadingIcon session={session} selected={selected} />
        <div className={cn("min-w-0 flex-1", singleColumn && "-translate-y-0.5")}>
          <div className="flex min-w-0 items-center text-sm font-medium leading-snug">
            {session.hasUnreadAiReply && (
              <span
                className="mr-1 flex w-4 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <span className="h-2 w-2 rounded-full bg-destructive" />
              </span>
            )}
            <span className="truncate">{session.title || "新会话"}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground/60">
            <span className="block truncate pr-28">{metaText}</span>
          </div>
        </div>
      </div>
      <span className={cn("pointer-events-none absolute right-2 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground/60", singleColumn ? "bottom-2.5" : "bottom-3")}>
        {formatShortDate(session.updatedAt)}
      </span>

      {/* 省略号操作菜单 */}
      {hasMenu && (
        <div
          className="absolute right-1 top-2"
          ref={menuOpen ? actionMenuRef : undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => {
              e.stopPropagation();
              setActionMenuId(menuOpen ? null : session.id);
            }}
            disabled={isLoading}
          >
            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
          </Button>

          {menuDropdown}
        </div>
      )}
    </div>
  );
}


interface SidebarBrandHeaderProps {
  className?: string;
}

function SidebarBrandHeader({ className }: SidebarBrandHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between gap-2 px-3 py-3", className)}>
      <div className="flex min-w-0 items-center">
        <span className="truncate text-sm font-semibold tracking-tight text-foreground">
          KY Agent
        </span>
      </div>
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => void refreshAll()}
        title="刷新会话列表"
      >
        <RefreshCw className="h-4 w-4" />
      </button>
    </div>
  );
}

interface SidebarNavProps {
  navItems: Array<{ tab: AppTab; label: string }>;
  activeTab: AppTab;
  isLoading: boolean;
  onNew: () => void;
  onTabChange?: (tab: AppTab) => void;
  beforeNavigate?: () => void;
  constrainNewButton?: boolean;
}

function getNavIcon(tab: AppTab) {
  if (tab === "profile") return Bot;
  if (tab === "settings") return Settings2;
  if (tab === "cron") return Clock;
  if (tab === "mcp") return Plug;
  if (tab === "scenarios") return LayoutGrid;
  return null;
}

function SidebarNav({ navItems, activeTab, isLoading, onNew, onTabChange, beforeNavigate, constrainNewButton = true }: SidebarNavProps) {
  if (!onTabChange) return null;
  return (
    <nav className="flex flex-col gap-1 px-2 pb-3">
      <button
        type="button"
        onClick={() => {
          beforeNavigate?.();
          onNew();
          if (activeTab !== "chat") onTabChange("chat");
        }}
        disabled={isLoading}
        className={cn("relative flex w-full items-center rounded-lg bg-brand-600 px-2 py-2 text-sm font-medium text-white transition-all hover:bg-brand-700 hover:shadow-[0_2px_8px_-2px_rgba(46,86,225,0.35)] disabled:opacity-50 disabled:hover:bg-brand-600 disabled:hover:shadow-none", constrainNewButton && "max-w-[200px]")}
      >
        <Plus className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
        <span className="w-full text-center">新建会话</span>
      </button>
      {navItems.map(({ tab, label }) => {
        const Icon = getNavIcon(tab);
        return (
          <button
            key={tab}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors",
              activeTab === tab ? NAV_ITEM_SELECTED : NAV_ITEM_UNSELECTED,
            )}
            onClick={() => {
              beforeNavigate?.();
              onTabChange(tab);
            }}
          >
            {Icon && <Icon className="h-4 w-4" />}
            {label}
          </button>
        );
      })}
    </nav>
  );
}

function RoleKitSidebarHint({
  onTabChange,
  beforeNavigate,
}: {
  onTabChange?: (tab: AppTab) => void;
  beforeNavigate?: () => void;
}) {
  const { user } = useAuth();
  const { config } = useRoleKitConfig();
  const { library, loading, error } = useScenarioLibrary();

  if (!config.roleKitV2Enabled || loading || error || !library) return null;

  const activeRoleId =
    user?.preferences?.activeRoleId && library.roles.some((role) => role.id === user.preferences?.activeRoleId)
      ? user.preferences.activeRoleId
      : matchRoleIdByPosition(library.roles, user?.position);
  const role = library.roles.find((item) => item.id === activeRoleId);
  if (!role) return null;

  return (
    <button
      type="button"
      className="mx-2 mb-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg border bg-card px-2 py-2 text-left text-xs transition-colors hover:bg-muted/60"
      onClick={() => {
        beforeNavigate?.();
        onTabChange?.("scenarios");
      }}
    >
      <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-brand-600" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{role.name}</span>
        <span className="block truncate text-muted-foreground">查看开箱场景</span>
      </span>
    </button>
  );
}

interface SidebarUserMenuFooterProps {
  authUser: AuthUser | null;
  authEnabled: boolean;
  roleLabel: string;
  showUserMenu: boolean;
  setShowUserMenu: Dispatch<SetStateAction<boolean>>;
  userMenuRef: React.RefObject<HTMLDivElement>;
  avatarInputRef: React.RefObject<HTMLInputElement>;
  onAvatarUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  isAdmin: boolean;
  isPlatformAdmin: boolean;
  onOpenSettings?: (section?: SettingsSectionId) => void;
  onChangePassword: () => void;
  onNavigateAdminTab?: (tab: AppTab) => void;
  onOpenAdminSettings?: (target: AdminSettingsTarget) => void;
  logout: () => void;
}

function SidebarUserMenuFooter({
  authUser,
  authEnabled,
  roleLabel,
  showUserMenu,
  setShowUserMenu,
  userMenuRef,
  avatarInputRef,
  onAvatarUpload,
  isAdmin,
  isPlatformAdmin,
  onOpenSettings,
  onChangePassword,
  onNavigateAdminTab,
  onOpenAdminSettings,
  logout,
}: SidebarUserMenuFooterProps) {
  return (
    <div className="border-t border-black/[0.06] px-2 py-2">
      <div className="relative" ref={userMenuRef}>
        <button
          type="button"
          onClick={() => authEnabled && authUser && setShowUserMenu((v) => !v)}
          disabled={!authUser}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
        >
          {authUser ? (
            authUser.avatar ? (
              <img
                src={authUser.avatar}
                alt=""
                className="h-7 w-7 shrink-0 rounded-full object-cover ring-2 ring-brand-100 ring-offset-1 ring-offset-background"
              />
            ) : (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-semibold text-primary-foreground shadow-[0_2px_6px_rgba(46,86,225,0.32)]">
                {authUser.username.charAt(0).toUpperCase()}
              </div>
            )
          ) : (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
              <User className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold leading-4">
              {authUser ? authUser.realName || authUser.username : "未登录"}
            </span>
            {authUser && (
              <span className="mt-0.5 block truncate text-[11px] leading-3 text-muted-foreground">
                {roleLabel}
              </span>
            )}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        </button>
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={onAvatarUpload}
        />
        {showUserMenu && authEnabled && authUser && (
          <div className="absolute bottom-full left-0 z-50 mb-2 max-h-[70vh] w-52 overflow-y-auto rounded-xl border bg-popover p-1 shadow-xl">
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <div className="truncate text-sm font-semibold">{authUser.realName || authUser.username}</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">@{authUser.username}</div>
            </div>

            <div className={USER_MENU_SECTION}>
              <button type="button" className={USER_MENU_ITEM} onClick={() => { setShowUserMenu(false); onOpenSettings?.("account"); }}>
                <UserCog className="h-3.5 w-3.5" />
                账户设置
              </button>
              <button type="button" className={USER_MENU_ITEM} onClick={() => { setShowUserMenu(false); avatarInputRef.current?.click(); }}>
                <Camera className="h-3.5 w-3.5" />
                更换头像
              </button>
              <button type="button" className={USER_MENU_ITEM} onClick={() => { setShowUserMenu(false); onChangePassword(); }}>
                <Lock className="h-3.5 w-3.5" />
                修改密码
              </button>
            </div>

            {isAdmin && (
              <div className={USER_MENU_SECTION}>
                <button type="button" className={USER_MENU_ITEM} onClick={() => { setShowUserMenu(false); onNavigateAdminTab?.("tenant-admin"); }}>
                  <Building2 className="h-3.5 w-3.5" />
                  组织分析
                </button>
                <button type="button" className={USER_MENU_ITEM} onClick={() => { setShowUserMenu(false); onOpenAdminSettings?.("tenant"); }}>
                  <Settings2 className="h-3.5 w-3.5" />
                  组织管理
                </button>
              </div>
            )}

            {isPlatformAdmin && (
              <div className={USER_MENU_SECTION}>
                <button type="button" className={USER_MENU_ITEM} onClick={() => { setShowUserMenu(false); onNavigateAdminTab?.("platform-admin"); }}>
                  <ShieldCheck className="h-3.5 w-3.5" />
                  平台分析
                </button>
                <button type="button" className={USER_MENU_ITEM} onClick={() => { setShowUserMenu(false); onOpenAdminSettings?.("platform"); }}>
                  <Settings2 className="h-3.5 w-3.5" />
                  平台管理
                </button>
              </div>
            )}

            <div className={USER_MENU_SECTION}>
              <button type="button" className={cn(USER_MENU_ITEM, "text-destructive hover:bg-destructive/10")} onClick={() => { setShowUserMenu(false); logout(); }}>
                <LogOut className="h-3.5 w-3.5" />
                退出登录
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface GroupHeaderActionsProps {
  menuId: string;
  groupId: string;
  actionMenuId: string | null;
  setActionMenuId: (id: string | null) => void;
  actionMenuRef: React.RefObject<HTMLDivElement>;
  setAddSessionsGroupKey: (id: string | null) => void;
  setRenameGroupId: (id: string | null) => void;
  setDeleteGroupId: (id: string | null) => void;
  onSelectSessions?: () => void;
  buttonClassName?: string;
}

function GroupHeaderActions({
  menuId,
  groupId,
  actionMenuId,
  setActionMenuId,
  actionMenuRef,
  setAddSessionsGroupKey,
  setRenameGroupId,
  setDeleteGroupId,
  onSelectSessions,
  buttonClassName,
}: GroupHeaderActionsProps) {
  const open = actionMenuId === menuId;
  return (
    <div className="relative" ref={open ? actionMenuRef : undefined}>
      <button
        type="button"
        className={cn("flex h-8 w-8 items-center justify-center rounded-full hover:bg-accent", buttonClassName)}
        onClick={() => setActionMenuId(open ? null : menuId)}
        title="更多操作"
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[120px] rounded-lg border bg-popover py-1 shadow-md">
          {onSelectSessions && (
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent" onClick={() => { setActionMenuId(null); onSelectSessions(); }}>
              <Check className="h-3.5 w-3.5" />
              选择会话
            </button>
          )}
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent" onClick={() => { setActionMenuId(null); setAddSessionsGroupKey(groupId); }}>
            <Plus className="h-3.5 w-3.5" />
            添加会话
          </button>
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent" onClick={() => { setActionMenuId(null); setRenameGroupId(groupId); }}>
            <Pencil className="h-3.5 w-3.5" />
            重命名
          </button>
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive transition-colors hover:bg-accent" onClick={() => { setActionMenuId(null); setDeleteGroupId(groupId); }}>
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        </div>
      )}
    </div>
  );
}

interface SidebarDialogsProps {
  sessions: ChatSessionIndexItem[];
  groups: Array<{ id: string; name: string; kind: "cron" | "manual"; sessionIds: string[] }>;
  onRename?: (sessionId: string, newTitle: string) => Promise<boolean>;
  renameSessionId: string | null;
  setRenameSessionId: (id: string | null) => void;
  renameGroupId: string | null;
  setRenameGroupId: (id: string | null) => void;
  deleteGroupId: string | null;
  setDeleteGroupId: (id: string | null) => void;
  handleRenameGroup: (newName: string) => Promise<boolean>;
  handleDeleteGroup: () => void;
  addToGroupSessionId: string | null;
  setAddToGroupSessionId: (id: string | null) => void;
  allGroups: SessionGroup[];
  handleAddToExistingGroup: (groupKey: string) => Promise<void>;
  handleCreateGroupAndAdd: (groupName: string) => Promise<void>;
  batchMoveSessionIds?: string[] | null;
  setBatchMoveSessionIds?: (ids: string[] | null) => void;
  handleBatchMoveToExistingGroup?: (groupKey: string) => Promise<void>;
  handleCreateGroupAndBatchMove?: (groupName: string) => Promise<void>;
  addSessionsGroupKey: string | null;
  setAddSessionsGroupKey: (id: string | null) => void;
  addSessionsExistingSessionIds: Set<string>;
  handleAddSessionsToGroup: (sessionIds: string[]) => Promise<void>;
  showPasswordDialog: boolean;
  setShowPasswordDialog: (open: boolean) => void;
  compactDialogOpen: boolean;
  setCompactDialogOpen: (open: boolean) => void;
  onCompact?: () => Promise<void>;
}

function SidebarDialogs({
  sessions,
  groups,
  onRename,
  renameSessionId,
  setRenameSessionId,
  renameGroupId,
  setRenameGroupId,
  deleteGroupId,
  setDeleteGroupId,
  handleRenameGroup,
  handleDeleteGroup,
  addToGroupSessionId,
  setAddToGroupSessionId,
  allGroups,
  handleAddToExistingGroup,
  handleCreateGroupAndAdd,
  batchMoveSessionIds,
  setBatchMoveSessionIds,
  handleBatchMoveToExistingGroup,
  handleCreateGroupAndBatchMove,
  addSessionsGroupKey,
  setAddSessionsGroupKey,
  addSessionsExistingSessionIds,
  handleAddSessionsToGroup,
  showPasswordDialog,
  setShowPasswordDialog,
  compactDialogOpen,
  setCompactDialogOpen,
  onCompact,
}: SidebarDialogsProps) {
  return (
    <>
      {onRename && (
        <RenameSessionDialog
          open={renameSessionId !== null}
          initialTitle={sessions.find((s) => s.id === renameSessionId)?.title || ""}
          onOpenChange={(open) => {
            if (!open) setRenameSessionId(null);
          }}
          onConfirm={(newTitle) => onRename(renameSessionId!, newTitle)}
        />
      )}

      <RenameSessionDialog
        open={renameGroupId !== null}
        initialTitle={groups.find((g) => g.id === renameGroupId)?.name ?? ""}
        dialogTitle="重命名分组"
        dialogDescription={
          groups.find((g) => g.id === renameGroupId)?.kind === "cron"
            ? "输入新的分组名称。注意：此分组关联定时任务，下次执行时名称可能被自动覆盖。"
            : "输入新的分组名称"
        }
        placeholder="分组名称"
        onOpenChange={(open) => {
          if (!open) setRenameGroupId(null);
        }}
        onConfirm={handleRenameGroup}
      />

      <DeleteGroupDialog
        open={deleteGroupId !== null}
        isCron={groups.find((g) => g.id === deleteGroupId)?.kind === "cron"}
        onOpenChange={(open) => {
          if (!open) setDeleteGroupId(null);
        }}
        onConfirm={handleDeleteGroup}
      />

      <AddToGroupDialog
        open={addToGroupSessionId !== null}
        onOpenChange={(open) => {
          if (!open) setAddToGroupSessionId(null);
        }}
        allGroups={allGroups}
        onAddToExistingGroup={handleAddToExistingGroup}
        onCreateGroupAndAdd={handleCreateGroupAndAdd}
      />

      <AddToGroupDialog
        open={Boolean(batchMoveSessionIds)}
        onOpenChange={(open) => {
          if (!open) setBatchMoveSessionIds?.(null);
        }}
        allGroups={allGroups}
        onAddToExistingGroup={(groupKey) => void handleBatchMoveToExistingGroup?.(groupKey)}
        onCreateGroupAndAdd={(groupName) => void handleCreateGroupAndBatchMove?.(groupName)}
      />

      <AddSessionsToGroupDialog
        open={addSessionsGroupKey !== null}
        onOpenChange={(open) => {
          if (!open) setAddSessionsGroupKey(null);
        }}
        allSessions={sessions}
        existingSessionIds={addSessionsExistingSessionIds}
        onConfirm={handleAddSessionsToGroup}
      />

      <ChangePasswordDialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog} />

      <Dialog open={compactDialogOpen} onOpenChange={setCompactDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>压缩上下文</DialogTitle>
            <DialogDescription>
              压缩会保留最近两轮对话原文与用户消息摘录，较早的历史将被摘要替代，以减少
              Token 占用；原始记录仍完整保留、可随时检索。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompactDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setCompactDialogOpen(false);
                onCompact?.();
              }}
            >
              确认压缩
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  DesktopSessionSidebar                                              */
/* ------------------------------------------------------------------ */
export function DesktopSessionSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
  onDeleteMany,
  onRename,
  onAutoTitle,
  onCompact,
  isLoading = false,
  className,
  activeTab = "chat",
  onTabChange,
  onPushTab,
  onOpenSettings,
  onOpenAdminSettings,
  isAdmin = false,
  isPlatformAdmin = false,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onLoadGroupSessions,
  hidden = false,
  onPreviewTrashSession,
  trashPreviewSessionId,
  unreadAiReplySessionIds,
  sidebarLayout = "double",
}: DesktopSessionSidebarProps) {
  const { user: authUser, logout, authEnabled, updateAvatar } = useAuth();
  // 会话列表头像开关：默认不显示（=== true 才显示），关闭时列表走紧凑单行布局
  const compactList = authUser?.preferences?.showSessionListAvatar !== true;
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const roleLabel = isPlatformAdmin ? "平台管理员" : isAdmin ? "组织管理员" : "用户";

  const handleAvatarUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
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
      // 重置 input 以允许再次选择同一文件
      e.target.value = "";
    },
    [updateAvatar],
  );

  // 压缩上下文确认弹窗
  const [compactDialogOpen, setCompactDialogOpen] = useState(false);

  // 操作菜单状态
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  // 排序齿轮下拉菜单
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // 拖拽中的索引（用于 dragover 时的视觉反馈和重排）
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // 重命名弹窗状态
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);

  // 会话搜索状态：独立于主 sessions 列表，避免污染分页/分组/未读状态。
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const sessionSearch = useSessionSearch(sessionSearchQuery);
  const isSessionSearchActive = sessionSearchQuery.trim().length > 0;

  // 分组重命名/删除状态
  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null);
  const [singleExpandedGroupKey, setSingleExpandedGroupKey] = useState<string | null>(null);

  // 侧边栏隐藏时重置弹出菜单状态
  useEffect(() => {
    if (hidden) {
      setShowUserMenu(false);
      setActionMenuId(null);
      setSortMenuOpen(false);
      setSingleExpandedGroupKey(null);
      setSessionSearchQuery("");
    }
  }, [hidden]);

  // 切换到非 chat tab（agent / 定时 / 编排 / 用户 / skills 等）时:
  // 自动收起右侧子栏，分组按钮高亮也通过下方的 className 判断同步取消
  useEffect(() => {
    if (activeTab !== "chat") {
      setSubPanelOpen(false);
      setActionMenuId(null);
      setSessionSearchQuery("");
    }
  }, [activeTab]);

  // 无限滚动 ref(useEffect 在 selectedView/subPanelOpen 声明后)
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // 选中视图状态：'__all__' | '__ungrouped__' | 真实 groupId
  type SelectedView = "__all__" | "__ungrouped__" | string;
  const [selectedView, setSelectedView] = useState<SelectedView>("__all__");
  // 初始是否展开右子栏：仅当处于 chat tab 且有选中会话时默认展开。
  // 定时/agent/编排/新建会话等场景刷新后默认收起，避免无意义占用空间。
  const [subPanelOpen, setSubPanelOpen] = useState(
    () => activeTab === "chat" && !!activeSessionId,
  );

  // 主栏宽度可拖动调整 + 持久化(双击拖动条恢复默认 160)
  const {
    width: mainPanelWidth,
    onMouseDown: onMainResizeMouseDown,
    onDoubleClick: onMainResizeDoubleClick,
  } = useResizableWidth({
    storageKey: "sidebar-mainpanel-width",
    defaultWidth: 160,
    minWidth: 140,
    maxWidth: 320,
  });

  // 子栏宽度可拖动调整 + 持久化(双击拖动条恢复默认 272)
  const {
    width: subPanelWidth,
    onMouseDown: onSubResizeMouseDown,
    onDoubleClick: onSubResizeDoubleClick,
  } = useResizableWidth({
    storageKey: "sidebar-subpanel-width",
    defaultWidth: 272,
    minWidth: 240,
    maxWidth: 600,
  });

  // 单栏模式整体宽度可拖动调整 + 持久化(双击拖动条恢复默认 280)
  const {
    width: singlePanelWidth,
    onMouseDown: onSingleResizeMouseDown,
    onDoubleClick: onSingleResizeDoubleClick,
  } = useResizableWidth({
    storageKey: "sidebar-singlepanel-width",
    defaultWidth: 280,
    minWidth: 260,
    maxWidth: 640,
  });

  const groupsHook = useGroups();
  // 所有用户都只看自己的会话，分组始终可编辑
  const isReadOnlyGroups = false;

  // 派生数据:所有分组内的 session id 集合
  const groupedIds = useMemo(
    () => new Set(groupsHook.groups.flatMap((g) => g.sessionIds)),
    [groupsHook.groups],
  );

  // 未分组会话数量
  const ungroupedCount = useMemo(
    () => sessions.filter((s) => !groupedIds.has(s.id)).length,
    [sessions, groupedIds],
  );

  // 聚合未读红点：基于「完整未读集 ∩ 分组成员全集」计算，两份数据都不受会话分页影响，
  // 因此能正确反映分页外的未读会话——根治「全部看着干净、切到分组冒红点」的不一致。
  // 残留 id（已删除会话）既不属于现存分组的 sessionIds、也不在已加载 sessions 里，故不会误亮。
  const unreadSet = unreadAiReplySessionIds ?? EMPTY_UNREAD_SET;
  const unreadByGroupId = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const g of groupsHook.groups) {
      map.set(
        g.id,
        g.sessionIds.some((id) => unreadSet.has(id)),
      );
    }
    return map;
  }, [groupsHook.groups, unreadSet]);
  const hasUnreadUngrouped = useMemo(
    () => sessions.some((s) => !groupedIds.has(s.id) && unreadSet.has(s.id)),
    [sessions, groupedIds, unreadSet],
  );
  // 「全部」= 未分组未读 ∪ 任一分组未读，自洽且不会被残留 id 永久点亮
  const hasUnreadAll = useMemo(
    () =>
      hasUnreadUngrouped ||
      groupsHook.groups.some((g) =>
        g.sessionIds.some((id) => unreadSet.has(id)),
      ),
    [hasUnreadUngrouped, groupsHook.groups, unreadSet],
  );

  // 当前视图的 sessions 子集
  const currentSessions = useMemo<ChatSessionIndexItem[]>(() => {
    if (selectedView === "__all__") return sessions;
    if (selectedView === "__ungrouped__")
      return sessions.filter((s) => !groupedIds.has(s.id));
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    const grp = groupsHook.groups.find((g) => g.id === selectedView);
    if (!grp) return [];
    return grp.sessionIds
      .map((id) => sessionMap.get(id))
      .filter((s): s is ChatSessionIndexItem => s !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [selectedView, sessions, groupedIds, groupsHook.groups]);

  // 当前真实分组对象(给子栏 Header 用)
  const currentRealGroup = useMemo(() => {
    if (selectedView === "__all__" || selectedView === "__ungrouped__")
      return null;
    return groupsHook.groups.find((g) => g.id === selectedView) ?? null;
  }, [selectedView, groupsHook.groups]);

  const sessionGroupNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groupsHook.groups) {
      for (const sessionId of group.sessionIds) {
        if (!map.has(sessionId)) map.set(sessionId, group.name);
      }
    }
    return map;
  }, [groupsHook.groups]);

  const buildSessionMetaText = useCallback(
    (session: ChatSessionIndexItem) => {
      const parts: string[] = [];
      if (selectedView === "__all__") {
        parts.push(sessionGroupNameMap.get(session.id) || "未分组");
      } else if (selectedView === "__ungrouped__") {
        parts.push("未分组");
      }
      return parts.join(" · ");
    },
    [selectedView, sessionGroupNameMap],
  );

  const singleColumnEntries = useMemo<SessionListEntry[]>(() => {
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const consumed = new Set<string>();
    const entries: SessionListEntry[] = [];

    for (const group of groupsHook.groups) {
      const children = group.sessionIds
        .map((sid) => sessionMap.get(sid))
        .filter((session): session is ChatSessionIndexItem => session !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (children.length === 0) continue;
      for (const child of children) consumed.add(child.id);
      entries.push({
        type: "group",
        group: {
          groupKey: group.id,
          name: group.name,
          kind: group.kind,
          children,
          latestUpdatedAt: children[0]?.updatedAt ?? group.updatedAt,
          count: children.length,
        },
      });
    }

    for (const session of sessions) {
      if (!consumed.has(session.id)) entries.push({ type: "session", session });
    }

    return entries.sort((a, b) => {
      const timeA = a.type === "session" ? a.session.updatedAt : a.group.latestUpdatedAt;
      const timeB = b.type === "session" ? b.session.updatedAt : b.group.latestUpdatedAt;
      return timeB - timeA;
    });
  }, [groupsHook.groups, sessions]);

  const singleExpandedGroup = useMemo(() => {
    const entry = singleColumnEntries.find(
      (item): item is Extract<SessionListEntry, { type: "group" }> =>
        item.type === "group" && item.group.groupKey === singleExpandedGroupKey,
    );
    return entry?.group ?? null;
  }, [singleColumnEntries, singleExpandedGroupKey]);

  const singleListTitle = singleExpandedGroup ? singleExpandedGroup.name : "会话";
  const singleListCount = singleExpandedGroup
    ? singleExpandedGroup.children.length
    : singleColumnEntries.length;

  // 左主栏分组列表排序：
  // - 编辑态：按 editing.draft 顺序
  // - custom 模式（非编辑）：按 sorting.order 顺序
  // - recent 模式：按"分组内最新会话 updatedAt"倒序，fallback group.updatedAt
  const recentSortedGroups = useMemo(() => {
    if (groupsHook.groups.length === 0) return groupsHook.groups;
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    return [...groupsHook.groups]
      .map((g) => {
        let latest = 0;
        for (const sid of g.sessionIds) {
          const s = sessionMap.get(sid);
          if (s && s.updatedAt > latest) latest = s.updatedAt;
        }
        return { group: g, latest: latest || g.updatedAt };
      })
      .sort((a, b) => b.latest - a.latest)
      .map((x) => x.group);
  }, [groupsHook.groups, sessions]);

  const sortedGroups = useMemo(() => {
    if (groupsHook.editing) {
      return applyGroupOrder(groupsHook.groups, groupsHook.editing.draft);
    }
    if (groupsHook.sorting.mode === "custom") {
      return applyGroupOrder(groupsHook.groups, groupsHook.sorting.order);
    }
    return recentSortedGroups;
  }, [
    groupsHook.groups,
    groupsHook.editing,
    groupsHook.sorting,
    recentSortedGroups,
  ]);

  const initialExpandDone = useRef(false);

  // 守护 effect:selectedView 指向已删除分组时 fallback 到全部
  useEffect(() => {
    if (groupsHook.loading) return;
    if (selectedView === "__all__" || selectedView === "__ungrouped__") return;
    if (!groupsHook.groups.some((g) => g.id === selectedView)) {
      setSelectedView("__all__");
      setSubPanelOpen(true);
    }
  }, [groupsHook.loading, groupsHook.groups, selectedView]);

  // 初始化时：如果当前会话在某个分组中，自动定位
  // 仅在用户尚未主动选择视图/会话时触发；任意手动操作后即标记 done，避免后续干扰
  useEffect(() => {
    if (
      initialExpandDone.current ||
      !activeSessionId ||
      groupsHook.groups.length === 0
    )
      return;
    const found = groupsHook.groups.find((g) =>
      g.sessionIds.includes(activeSessionId),
    );
    if (found) {
      initialExpandDone.current = true;
      setSelectedView(found.id);
    }
  }, [activeSessionId, groupsHook.groups]);

  // 跟踪已通过 onLoadGroupSessions 加载过的分组，避免重复请求
  const loadedGroupsRef = useRef<Set<string>>(new Set());

  // selectedView 变成分组 id 时,确保该分组的全部会话已经被加载进全局 sessions 列表
  // 适用于 auto-switch、selectedView 程序化变更等不经过 handleViewClick 的路径
  useEffect(() => {
    if (selectedView === "__all__" || selectedView === "__ungrouped__") return;
    if (!onLoadGroupSessions) return;
    if (loadedGroupsRef.current.has(selectedView)) return;
    loadedGroupsRef.current.add(selectedView);
    void onLoadGroupSessions(selectedView);
  }, [selectedView, onLoadGroupSessions]);

  // 无限滚动
  useEffect(() => {
    if (
      hidden ||
      (sidebarLayout === "double" && (!subPanelOpen || isSessionSearchActive)) ||
      !onLoadMore ||
      !hasMore
    ) return;
    const el = scrollAreaRef.current;
    if (!el) return;
    const viewport = el.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement | null;
    if (!viewport) return;
    const onScroll = () => {
      if (
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
        200
      ) {
        onLoadMore();
      }
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [hidden, sidebarLayout, subPanelOpen, selectedView, isSessionSearchActive, onLoadMore, hasMore]);

  // outside click: 用户菜单
  useEffect(() => {
    if (hidden || !showUserMenu) return;
    function handleClick(e: MouseEvent) {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(e.target as Node)
      ) {
        setShowUserMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [hidden, showUserMenu]);

  // outside click: 操作菜单
  useEffect(() => {
    if (hidden || !actionMenuId) return;
    function handleClick(e: MouseEvent) {
      if (
        actionMenuRef.current &&
        !actionMenuRef.current.contains(e.target as Node)
      ) {
        setActionMenuId(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [hidden, actionMenuId]);

  // outside click: 排序菜单
  useEffect(() => {
    if (hidden || !sortMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        sortMenuRef.current &&
        !sortMenuRef.current.contains(e.target as Node)
      ) {
        setSortMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [hidden, sortMenuOpen]);

  const navItems = useMemo(
    () => [
      ...baseNavItems.filter((item) => !item.adminOnly || isAdmin),
      // 场景库入口仅桌面端展示（不进 baseNavItems，避免移动端 MobileSessionList 跟着出现）
      { tab: "scenarios" as AppTab, label: "场景库" },
    ],
    [isAdmin],
  );

  const [singleSelectionMode, setSingleSelectionMode] = useState(false);
  const [selectedSingleSessionIds, setSelectedSingleSessionIds] = useState<Set<string>>(new Set());
  const [batchMoveSessionIds, setBatchMoveSessionIds] = useState<string[] | null>(null);

  const clearSingleSelection = useCallback(() => {
    setSingleSelectionMode(false);
    setSelectedSingleSessionIds(new Set());
    setBatchMoveSessionIds(null);
  }, []);

  const beginSingleSelection = useCallback(() => {
    setActionMenuId(null);
    setSelectedSingleSessionIds(new Set());
    setBatchMoveSessionIds(null);
    setSingleSelectionMode(true);
  }, []);

  const toggleSingleSelection = useCallback((sessionId: string) => {
    setSelectedSingleSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const selectedSingleCount = selectedSingleSessionIds.size;

  // 选择会话
  const handleSelect = useCallback(
    (id: string) => {
      if (singleSelectionMode) {
        toggleSingleSelection(id);
        return;
      }
      // 用户主动点击会话即视为已交互,关闭后续 auto-switch effect
      initialExpandDone.current = true;
      onSelect(id);
      if (activeTab !== "chat" && onTabChange) onTabChange("chat");
    },
    [singleSelectionMode, toggleSingleSelection, onSelect, activeTab, onTabChange],
  );

  // 点击左栏视图项(全部/未分组/真实分组)
  const handleViewClick = useCallback(
    (view: SelectedView) => {
      // 编辑排序模式下禁止切换视图
      if (groupsHook.editing) return;
      // 用户主动选择视图即视为已交互,关闭后续 auto-switch effect
      initialExpandDone.current = true;
      setActionMenuId(null);

      // 从非 chat tab(agent/定时/编排等) 直接点击分组：
      // 切回 chat、新建会话、打开子栏并定位到该分组
      if (activeTab !== "chat") {
        onTabChange?.("chat");
        onNew();
        setSelectedView(view);
        setSubPanelOpen(true);
        return;
      }

      // 已经在 chat tab：原有 toggle / 切换逻辑
      if (view === selectedView) {
        setSubPanelOpen((prev) => !prev);
      } else {
        setSelectedView(view);
        setSubPanelOpen(true);
        // 真实加载逻辑由上面的 useEffect 统一处理（基于 loadedGroupsRef 去重）
      }
    },
    [activeTab, onTabChange, onNew, selectedView, groupsHook.editing],
  );

  // --- 分组操作 ---
  // "添加到分组" 弹窗
  const [addToGroupSessionId, setAddToGroupSessionId] = useState<string | null>(
    null,
  );
  // "添加会话到分组" 弹窗
  const [addSessionsGroupKey, setAddSessionsGroupKey] = useState<string | null>(
    null,
  );

  // 获取所有分组（用于 AddToGroupDialog）— 复用 sortedGroups 以应用用户的排序偏好（custom/recent）
  const allGroups = useMemo<SessionGroup[]>(() => {
    return sortedGroups.map((g) => ({
      groupKey: g.id,
      name: g.name,
      kind: g.kind,
      children: [],
      latestUpdatedAt: g.updatedAt,
      count: g.sessionIds.length,
    }));
  }, [sortedGroups]);

  const handleAddToExistingGroup = useCallback(
    async (groupKey: string) => {
      if (!addToGroupSessionId) return;
      // Backend handles cross-group cleanup automatically
      await groupsHook.addSessionsToGroup(groupKey, [addToGroupSessionId]);
      setAddToGroupSessionId(null);
    },
    [addToGroupSessionId, groupsHook],
  );

  const handleCreateGroupAndAdd = useCallback(
    async (groupName: string) => {
      if (!addToGroupSessionId) return;
      await groupsHook.createGroup(groupName, [addToGroupSessionId]);
      setAddToGroupSessionId(null);
    },
    [addToGroupSessionId, groupsHook],
  );

  const handleBatchMoveToExistingGroup = useCallback(
    async (groupKey: string) => {
      if (!batchMoveSessionIds || batchMoveSessionIds.length === 0) return;
      await groupsHook.addSessionsToGroup(groupKey, batchMoveSessionIds);
      clearSingleSelection();
    },
    [batchMoveSessionIds, clearSingleSelection, groupsHook],
  );

  const handleCreateGroupAndBatchMove = useCallback(
    async (groupName: string) => {
      if (!batchMoveSessionIds || batchMoveSessionIds.length === 0) return;
      await groupsHook.createGroup(groupName, batchMoveSessionIds);
      clearSingleSelection();
    },
    [batchMoveSessionIds, clearSingleSelection, groupsHook],
  );

  const handleBatchDeleteSelected = useCallback(() => {
    if (selectedSingleSessionIds.size === 0) return;
    const sessionIds = Array.from(selectedSingleSessionIds);
    if (onDeleteMany) {
      onDeleteMany(sessionIds);
    } else if (onDelete && sessionIds.length === 1) {
      onDelete(sessionIds[0]);
    }
    clearSingleSelection();
  }, [clearSingleSelection, onDelete, onDeleteMany, selectedSingleSessionIds]);

  const handleAddSessionsToGroup = useCallback(
    async (sessionIds: string[]) => {
      if (!addSessionsGroupKey) return;
      await groupsHook.addSessionsToGroup(addSessionsGroupKey, sessionIds);
      setAddSessionsGroupKey(null);
    },
    [addSessionsGroupKey, groupsHook],
  );

  const handleRemoveFromGroup = useCallback(
    async (sessionId: string) => {
      if (selectedView === "__all__" || selectedView === "__ungrouped__")
        return;
      await groupsHook.removeSessionsFromGroup(selectedView, [sessionId]);
    },
    [selectedView, groupsHook],
  );

  // 分组重命名
  const handleRenameGroup = useCallback(
    async (newName: string): Promise<boolean> => {
      if (!renameGroupId) return false;
      await groupsHook.renameGroup(renameGroupId, newName);
      return true;
    },
    [renameGroupId, groupsHook],
  );

  // 分组删除
  const handleDeleteGroup = useCallback(() => {
    if (!deleteGroupId) return;
    if (selectedView === deleteGroupId) {
      setSelectedView("__all__");
      setSubPanelOpen(true);
    }
    groupsHook.deleteGroup(deleteGroupId);
    setDeleteGroupId(null);
  }, [deleteGroupId, selectedView, groupsHook]);


  const sessionSearchBox = (
    <div className="border-b px-3 py-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          value={sessionSearchQuery}
          onChange={(e) => setSessionSearchQuery(e.target.value)}
          placeholder="搜索会话内容..."
          className="h-8 pl-8 pr-8 text-sm"
        />
        {sessionSearchQuery && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
            onClick={() => setSessionSearchQuery("")}
            title="清空搜索"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );

  if (sidebarLayout === "single") {
    const visibleSingleSessions = singleExpandedGroup?.children ?? [];
    return (
      <aside
        className={cn(
          "relative flex h-full shrink-0 flex-col border-r border-black/[0.08] bg-background",
          hidden && "hidden",
          className,
        )}
        style={{ width: singlePanelWidth }}
        // @ts-expect-error -- inert is a valid HTML attribute, React types lag behind
        inert={hidden ? "" : undefined}
      >
        <SidebarBrandHeader />

        <SidebarNav
          navItems={navItems}
          activeTab={activeTab}
          isLoading={isLoading}
          onNew={onNew}
          onTabChange={onTabChange}
          beforeNavigate={() => setSingleExpandedGroupKey(null)}
          constrainNewButton={false}
        />
        <RoleKitSidebarHint
          onTabChange={onTabChange}
          beforeNavigate={() => setSingleExpandedGroupKey(null)}
        />

        <div className="mx-2 my-1 border-t" />
        {sessionSearchBox}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="absolute inset-0 flex flex-col bg-card" style={{ transform: singleExpandedGroup ? "translateX(-100%)" : "translateX(0)", transition: "transform 233ms cubic-bezier(.25,.1,.25,1)" }}>
            <div className="relative flex h-12 items-center justify-between border-b px-3">
              <div className="pointer-events-none min-w-0 flex-1 pr-3">
                <div className="truncate text-sm font-semibold">全部会话<span className="ml-1 font-normal text-muted-foreground">({singleColumnEntries.length})</span></div>
              </div>
              {singleSelectionMode ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={clearSingleSelection}>取消</Button>
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs text-destructive hover:text-destructive" disabled={!(onDeleteMany || onDelete) || selectedSingleCount === 0} onClick={handleBatchDeleteSelected}>删除</Button>
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={isReadOnlyGroups || selectedSingleCount === 0} onClick={() => setBatchMoveSessionIds(Array.from(selectedSingleSessionIds))}>移动</Button>
                </div>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={beginSingleSelection}>选择</Button>
              )}
            </div>
            <ScrollArea ref={scrollAreaRef} className="flex-1 [&_[style*=table]]:!block">
              <div className="px-2 pb-3 flex flex-col gap-1">
                {isSessionSearchActive ? (
                  <SessionSearchResults
                    hits={sessionSearch.hits}
                    activeSessionId={activeSessionId}
                    isSearching={sessionSearch.isSearching}
                    isLoadingMore={sessionSearch.isLoadingMore}
                    hasMore={sessionSearch.hasMore}
                    error={sessionSearch.error}
                    onSelect={handleSelect}
                    onLoadMore={sessionSearch.loadMore}
                  />
                ) : isLoading && singleColumnEntries.length === 0 ? (
                  <div className="flex items-center justify-center py-6 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中...</div>
                ) : singleColumnEntries.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-muted-foreground">暂无会话</div>
                ) : singleColumnEntries.map((entry) => entry.type === "session" ? (
                  <SessionRow key={entry.session.id} session={entry.session} active={!singleSelectionMode && entry.session.id === activeSessionId} isLoading={isLoading} onSelect={handleSelect} onDelete={onDelete} onRename={onRename} onAutoTitle={onAutoTitle} actionMenuId={actionMenuId} setActionMenuId={setActionMenuId} actionMenuRef={actionMenuRef} setRenameSessionId={setRenameSessionId} onAddToGroup={isReadOnlyGroups ? undefined : setAddToGroupSessionId} onCompact={entry.session.id === activeSessionId && onCompact ? () => setCompactDialogOpen(true) : undefined} selectionMode={singleSelectionMode} selected={selectedSingleSessionIds.has(entry.session.id)} singleColumn compact={compactList} />
                ) : compactList ? (
                  <button key={entry.group.groupKey} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted" onClick={() => { setActionMenuId(null); setSingleExpandedGroupKey(entry.group.groupKey); void onLoadGroupSessions?.(entry.group.groupKey); }}>
                    <CompactGroupLeadingIcon kind={entry.group.kind} />
                    {unreadByGroupId.get(entry.group.groupKey) && <GroupUnreadDot />}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5">
                      {entry.group.name}
                      <span className="ml-1 font-normal text-muted-foreground/60">({entry.group.count})</span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground/60">{formatShortDate(entry.group.latestUpdatedAt)}</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                  </button>
                ) : (
                  <button key={entry.group.groupKey} type="button" className="group flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted" onClick={() => { setActionMenuId(null); setSingleExpandedGroupKey(entry.group.groupKey); void onLoadGroupSessions?.(entry.group.groupKey); }}>
                    <GroupLeadingIcon kind={entry.group.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{entry.group.name}</span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground/60">{entry.group.kind === "cron" ? "cron" : "分组"} · {entry.group.count} 个会话</span>
                    </span>
                    {unreadByGroupId.get(entry.group.groupKey) && <GroupUnreadDot />}
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                      <span className="translate-y-[3px] text-xs tabular-nums text-muted-foreground/60">{formatShortDate(entry.group.latestUpdatedAt)}</span>
                    </span>
                  </button>
                ))}
                {!isSessionSearchActive && isLoadingMore && <div className="flex items-center justify-center py-3 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /></div>}
                {!isSessionSearchActive && !hasMore && sessions.length > 0 && !isLoading && <div className="py-3 text-center text-xs text-muted-foreground/40">没有更多了</div>}
              </div>
            </ScrollArea>
          </div>

          <div className="absolute inset-0 flex flex-col bg-card" style={{ transform: singleExpandedGroup ? "translateX(0)" : "translateX(100%)", transition: "transform 233ms cubic-bezier(.25,.1,.25,1)" }}>
            <div className="relative flex h-12 items-center gap-2 border-b px-3">
              <button type="button" className="inline-flex min-w-0 items-center gap-1.5 rounded-lg pr-2 text-left transition-colors hover:bg-accent" onClick={() => { clearSingleSelection(); setSingleExpandedGroupKey(null); }} title="返回">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
                  <ChevronLeft className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{singleListTitle}<span className="ml-1 font-normal text-muted-foreground">({singleListCount})</span></span>
                </span>
              </button>
              <div className="min-w-0 flex-1" aria-hidden="true" />
              {singleSelectionMode ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={clearSingleSelection}>取消</Button>
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs text-destructive hover:text-destructive" disabled={!(onDeleteMany || onDelete) || selectedSingleCount === 0} onClick={handleBatchDeleteSelected}>删除</Button>
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={isReadOnlyGroups || selectedSingleCount === 0} onClick={() => setBatchMoveSessionIds(Array.from(selectedSingleSessionIds))}>移动</Button>
                </div>
              ) : (
                <div className="relative shrink-0">
                  {singleExpandedGroup && !isReadOnlyGroups && (
                    <GroupHeaderActions
                      menuId="single-header-actions"
                      groupId={singleExpandedGroup.groupKey}
                      actionMenuId={actionMenuId}
                      setActionMenuId={setActionMenuId}
                      actionMenuRef={actionMenuRef}
                      setAddSessionsGroupKey={setAddSessionsGroupKey}
                      setRenameGroupId={setRenameGroupId}
                      setDeleteGroupId={setDeleteGroupId}
                      onSelectSessions={beginSingleSelection}
                    />
                  )}
                </div>
              )}
            </div>
            <ScrollArea className="flex-1 [&_[style*=table]]:!block">
              <div className="px-2 py-1">
                {isSessionSearchActive ? <SessionSearchResults hits={sessionSearch.hits} activeSessionId={activeSessionId} isSearching={sessionSearch.isSearching} isLoadingMore={sessionSearch.isLoadingMore} hasMore={sessionSearch.hasMore} error={sessionSearch.error} onSelect={handleSelect} onLoadMore={sessionSearch.loadMore} /> : visibleSingleSessions.length === 0 ? <div className="px-2 py-6 text-center text-sm text-muted-foreground">暂无会话</div> : <div className="flex flex-col gap-1">{visibleSingleSessions.map((s) => <SessionRow key={s.id} session={s} active={!singleSelectionMode && s.id === activeSessionId} isLoading={isLoading} onSelect={handleSelect} onDelete={onDelete} onRename={onRename} onAutoTitle={onAutoTitle} actionMenuId={actionMenuId} setActionMenuId={setActionMenuId} actionMenuRef={actionMenuRef} setRenameSessionId={setRenameSessionId} onAddToGroup={isReadOnlyGroups ? undefined : setAddToGroupSessionId} onRemoveFromGroup={!isReadOnlyGroups ? (id) => singleExpandedGroup && groupsHook.removeSessionsFromGroup(singleExpandedGroup.groupKey, [id]) : undefined} isInManualGroup={!isReadOnlyGroups} onCompact={s.id === activeSessionId && onCompact ? () => setCompactDialogOpen(true) : undefined} selectionMode={singleSelectionMode} selected={selectedSingleSessionIds.has(s.id)} singleColumn compact={compactList} />)}</div>}
              </div>
            </ScrollArea>
          </div>
        </div>

        <SidebarUserMenuFooter
          authUser={authUser}
          authEnabled={authEnabled}
          roleLabel={roleLabel}
          showUserMenu={showUserMenu}
          setShowUserMenu={setShowUserMenu}
          userMenuRef={userMenuRef}
          avatarInputRef={avatarInputRef}
          onAvatarUpload={handleAvatarUpload}
          isAdmin={isAdmin}
          isPlatformAdmin={isPlatformAdmin}
          onOpenSettings={onOpenSettings}
          onChangePassword={() => setShowPasswordDialog(true)}
          onNavigateAdminTab={(tab) => (onPushTab ?? onTabChange)?.(tab)}
          onOpenAdminSettings={onOpenAdminSettings}
          logout={logout}
        />

        <div
          className="group absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize"
          onMouseDown={onSingleResizeMouseDown}
          onDoubleClick={onSingleResizeDoubleClick}
          title="拖动调整侧边栏宽度,双击恢复默认"
        >
          <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-primary/50" />
        </div>

        <SidebarDialogs
          sessions={sessions}
          groups={groupsHook.groups}
          onRename={onRename}
          renameSessionId={renameSessionId}
          setRenameSessionId={setRenameSessionId}
          renameGroupId={renameGroupId}
          setRenameGroupId={setRenameGroupId}
          deleteGroupId={deleteGroupId}
          setDeleteGroupId={setDeleteGroupId}
          handleRenameGroup={handleRenameGroup}
          handleDeleteGroup={handleDeleteGroup}
          addToGroupSessionId={addToGroupSessionId}
          setAddToGroupSessionId={setAddToGroupSessionId}
          allGroups={allGroups}
          handleAddToExistingGroup={handleAddToExistingGroup}
          handleCreateGroupAndAdd={handleCreateGroupAndAdd}
          batchMoveSessionIds={batchMoveSessionIds}
          setBatchMoveSessionIds={setBatchMoveSessionIds}
          handleBatchMoveToExistingGroup={handleBatchMoveToExistingGroup}
          handleCreateGroupAndBatchMove={handleCreateGroupAndBatchMove}
          addSessionsGroupKey={addSessionsGroupKey}
          setAddSessionsGroupKey={setAddSessionsGroupKey}
          addSessionsExistingSessionIds={
            addSessionsGroupKey && singleExpandedGroup
              ? new Set(singleExpandedGroup.children.map((s) => s.id))
              : new Set()
          }
          handleAddSessionsToGroup={handleAddSessionsToGroup}
          showPasswordDialog={showPasswordDialog}
          setShowPasswordDialog={setShowPasswordDialog}
          compactDialogOpen={compactDialogOpen}
          setCompactDialogOpen={setCompactDialogOpen}
          onCompact={onCompact}
        />
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "relative flex h-full shrink-0 border-r border-black/[0.08] bg-background",
        hidden && "hidden",
        className,
      )}
      style={{
        width:
          subPanelOpen || showTrash
            ? mainPanelWidth + subPanelWidth
            : mainPanelWidth,
      }}
      // @ts-expect-error -- inert is a valid HTML attribute, React types lag behind
      inert={hidden ? "" : undefined}
    >
      <div className="flex h-full w-full">
        {/* 左主栏：导航 + 分组目录(可拖动调宽) */}
        <div
          className="relative flex h-full shrink-0 flex-col border-r border-black/[0.08]"
          style={{ width: mainPanelWidth }}
        >
          {/* Header: 品牌徽标 + 刷新 */}
          <SidebarBrandHeader />

          {/* Navigation: 新建会话 + 竖排导航 */}
          <SidebarNav
            navItems={navItems}
            activeTab={activeTab}
            isLoading={isLoading}
            onNew={onNew}
            onTabChange={onTabChange}
          />
          <RoleKitSidebarHint onTabChange={onTabChange} />

          {/* 导航与分组之间的分隔线 */}
          <div className="mx-2 my-1 border-t" />

          {/* 分组导航列表 */}
          <ScrollArea className="flex-1">
            <div className="px-2 pb-3 flex flex-col gap-1">
              {/* 排序工具栏：齿轮 + 三态右按钮 */}
                <div className="flex items-center justify-between gap-1 px-1 pt-0.5 pb-1">
                  <div className="relative" ref={sortMenuRef}>
                    <button
                      type="button"
                      title="排序方式"
                      disabled={!!groupsHook.editing}
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
                        !groupsHook.editing &&
                          "hover:bg-accent hover:text-foreground",
                        groupsHook.editing && "opacity-40 cursor-not-allowed",
                      )}
                      onClick={() => setSortMenuOpen((v) => !v)}
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                    {sortMenuOpen && (
                      <div className="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-lg border bg-popover py-1 shadow-md">
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                          onClick={() => {
                            setSortMenuOpen(false);
                            void groupsHook.setSortingMode("recent");
                          }}
                        >
                          最新
                          {groupsHook.sorting.mode === "recent" && (
                            <Check className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                          onClick={() => {
                            setSortMenuOpen(false);
                            // 切到 custom 时用当前显示顺序作为初始 order
                            const fallback = recentSortedGroups.map(
                              (g) => g.id,
                            );
                            void groupsHook.setSortingMode("custom", fallback);
                          }}
                        >
                          自定义顺序
                          {groupsHook.sorting.mode === "custom" && (
                            <Check className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 右侧三态按钮 */}
                  {groupsHook.editing ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title="取消"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        onClick={() => groupsHook.cancelEditing()}
                      >
                        <X className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="确认"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10"
                        onClick={() => void groupsHook.commitEditing()}
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </div>
                  ) : groupsHook.sorting.mode === "custom" ? (
                    <button
                      type="button"
                      title="自定义顺序"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        const currentOrder = sortedGroups.map((g) => g.id);
                        groupsHook.enterEditing(currentOrder);
                      }}
                    >
                      <GripVertical className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              {/* 全部 */}
              <button
                type="button"
                className={cn(
                  "flex w-full items-center rounded-lg pl-2 pr-1.5 py-2 text-sm font-medium transition-colors",
                  activeTab === "chat" && selectedView === "__all__"
                    ? NAV_ITEM_SELECTED
                    : NAV_ITEM_UNSELECTED,
                  groupsHook.editing && "cursor-not-allowed",
                )}
                onClick={() => handleViewClick("__all__")}
              >
                <span className="truncate flex-1 text-left">全部</span>
                {hasUnreadAll && <GroupUnreadDot />}
                <span className="ml-1 shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
                  {sessions.length}
                </span>
              </button>
              {/* 未分组 */}
              <button
                type="button"
                className={cn(
                  "flex w-full items-center rounded-lg pl-2 pr-1.5 py-2 text-sm font-medium transition-colors",
                  activeTab === "chat" && selectedView === "__ungrouped__"
                    ? NAV_ITEM_SELECTED
                    : NAV_ITEM_UNSELECTED,
                  groupsHook.editing && "cursor-not-allowed",
                )}
                onClick={() => handleViewClick("__ungrouped__")}
              >
                <span className="truncate flex-1 text-left">未分组</span>
                {hasUnreadUngrouped && <GroupUnreadDot />}
                <span className="ml-1 shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
                  {ungroupedCount}
                </span>
              </button>
              {/* 真实分组列表 */}
              {groupsHook.loading && groupsHook.groups.length === 0 ? (
                <div className="flex items-center justify-center py-3 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                </div>
              ) : (
                sortedGroups.map((g, idx) => {
                  const isEditing = !!groupsHook.editing;
                  const isDragging = isEditing && dragIndex === idx;
                  const isDragOver =
                    isEditing &&
                    dragOverIndex === idx &&
                    dragIndex !== null &&
                    dragIndex !== idx;
                  return (
                    <div
                      key={g.id}
                      draggable={isEditing}
                      onDragStart={
                        isEditing
                          ? (e) => {
                              setDragIndex(idx);
                              e.dataTransfer.effectAllowed = "move";
                              // Firefox 需要 setData 才能开始拖拽
                              e.dataTransfer.setData("text/plain", g.id);
                            }
                          : undefined
                      }
                      onDragEnter={
                        isEditing
                          ? (e) => {
                              e.preventDefault();
                              setDragOverIndex(idx);
                            }
                          : undefined
                      }
                      onDragOver={
                        isEditing
                          ? (e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              if (dragOverIndex !== idx) setDragOverIndex(idx);
                            }
                          : undefined
                      }
                      onDragEnd={
                        isEditing
                          ? () => {
                              setDragIndex(null);
                              setDragOverIndex(null);
                            }
                          : undefined
                      }
                      onDrop={
                        isEditing
                          ? (e) => {
                              e.preventDefault();
                              if (dragIndex !== null && dragIndex !== idx) {
                                groupsHook.reorderDraft(dragIndex, idx);
                              }
                              setDragIndex(null);
                              setDragOverIndex(null);
                            }
                          : undefined
                      }
                      className={cn(
                        "relative",
                        isDragging && "opacity-40",
                        isDragOver &&
                          "before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-primary",
                      )}
                    >
                      <button
                        type="button"
                        className={cn(
                          "flex w-full items-center rounded-lg pl-2 pr-1.5 py-2 text-sm font-medium transition-colors",
                          activeTab === "chat" &&
                            selectedView === g.id &&
                            !isEditing
                            ? NAV_ITEM_SELECTED
                            : NAV_ITEM_UNSELECTED,
                          isEditing && "cursor-grab active:cursor-grabbing",
                        )}
                        onClick={() => handleViewClick(g.id)}
                      >
                        <span className="truncate flex-1 text-left">
                          {g.name}
                        </span>
                        {!isEditing && unreadByGroupId.get(g.id) && (
                          <GroupUnreadDot />
                        )}
                        {isEditing ? (
                          <GripVertical className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                        ) : (
                          <span className="ml-1 shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
                            {g.sessionIds.length}
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>

          {/* Footer: 头像 + 用户名 + 上下箭头（点击展开用户菜单） */}
          <SidebarUserMenuFooter
            authUser={authUser}
            authEnabled={authEnabled}
            roleLabel={roleLabel}
            showUserMenu={showUserMenu}
            setShowUserMenu={setShowUserMenu}
            userMenuRef={userMenuRef}
            avatarInputRef={avatarInputRef}
            onAvatarUpload={handleAvatarUpload}
            isAdmin={isAdmin}
            isPlatformAdmin={isPlatformAdmin}
            onOpenSettings={onOpenSettings}
            onChangePassword={() => setShowPasswordDialog(true)}
            onNavigateAdminTab={(tab) => {
              setSubPanelOpen(false);
              (onPushTab ?? onTabChange)?.(tab);
            }}
            onOpenAdminSettings={(target) => {
              setSubPanelOpen(false);
              onOpenAdminSettings?.(target);
            }}
            logout={logout}
          />

          {/* 主栏拖动条:贴主栏右边线,控制 mainPanelWidth */}
          <div
            className="group absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize"
            onMouseDown={onMainResizeMouseDown}
            onDoubleClick={onMainResizeDoubleClick}
            title="拖动调整主栏宽度,双击恢复默认"
          >
            <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-primary/50" />
          </div>
        </div>

        {/* 右子栏：会话列表 / 回收站 */}
        {(subPanelOpen || showTrash) && (
          <div
            className="flex min-w-0 shrink-0 flex-col bg-card"
            style={{ width: subPanelWidth }}
          >
            {showTrash && isAdmin ? (
              <TrashView
                onClose={() => {
                  setShowTrash(false);
                  onPreviewTrashSession?.(null);
                }}
                onPreviewSession={(id) => onPreviewTrashSession?.(id)}
                activePreviewId={trashPreviewSessionId}
              />
            ) : (
              <>
                {/* Header */}
                <div className="relative flex h-12 items-center justify-between px-4 border-b">
                  <button
                    type="button"
                    className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full transition-opacity hover:bg-accent active:opacity-70"
                    onClick={() => setSubPanelOpen(false)}
                    title="收起"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  {/* 标题绝对居中于整个 header,不受左右按钮宽度差影响 */}
                  <div className="pointer-events-none absolute left-1/2 top-1/2 max-w-[60%] -translate-x-1/2 -translate-y-1/2 text-center">
                    <div className="truncate text-sm font-semibold">
                      {isSessionSearchActive
                        ? "搜索"
                        : selectedView === "__all__"
                          ? "全部"
                          : selectedView === "__ungrouped__"
                            ? "未分组"
                            : (currentRealGroup?.name ?? "")}
                      <span className="ml-1 font-normal text-muted-foreground">
                        ({isSessionSearchActive ? sessionSearch.hits.length : currentSessions.length})
                      </span>
                    </div>
                  </div>
                  <div className="relative z-10 flex items-center gap-1">
                    {currentRealGroup && !isReadOnlyGroups && (
                      <GroupHeaderActions
                        menuId="header-actions"
                        groupId={currentRealGroup.id}
                        actionMenuId={actionMenuId}
                        setActionMenuId={setActionMenuId}
                        actionMenuRef={actionMenuRef}
                        setAddSessionsGroupKey={setAddSessionsGroupKey}
                        setRenameGroupId={setRenameGroupId}
                        setDeleteGroupId={setDeleteGroupId}
                        buttonClassName="transition-opacity active:opacity-70"
                      />
                    )}
                  </div>
                </div>

                {/* 会话搜索：结果态与主列表态隔离，避免影响分组/分页 state */}
                {sessionSearchBox}

                {/* 会话列表 */}
                <ScrollArea
                  ref={scrollAreaRef}
                  className="flex-1 [&_[style*=table]]:!block"
                >
                  <div className="px-2 py-1">
                    {isSessionSearchActive ? (
                      <SessionSearchResults
                        hits={sessionSearch.hits}
                        activeSessionId={activeSessionId}
                        isSearching={sessionSearch.isSearching}
                        isLoadingMore={sessionSearch.isLoadingMore}
                        hasMore={sessionSearch.hasMore}
                        error={sessionSearch.error}
                        onSelect={handleSelect}
                        onLoadMore={sessionSearch.loadMore}
                      />
                    ) : isLoading && currentSessions.length === 0 ? (
                      <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        加载中...
                      </div>
                    ) : currentSessions.length === 0 ? (
                      <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                        暂无会话
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {currentSessions.map((s) => {
                          const isReal =
                            selectedView !== "__all__" &&
                            selectedView !== "__ungrouped__";
                          const inGroup = isReal && !isReadOnlyGroups;
                          return (
                            <SessionRow
                              key={s.id}
                              session={s}
                              active={s.id === activeSessionId}
                              metaText={buildSessionMetaText(s)}
                              isLoading={isLoading}
                              onSelect={handleSelect}
                              onDelete={onDelete}
                              onRename={onRename}
                              onAutoTitle={onAutoTitle}
                              actionMenuId={actionMenuId}
                              setActionMenuId={setActionMenuId}
                              actionMenuRef={actionMenuRef}
                              setRenameSessionId={setRenameSessionId}
                              onAddToGroup={
                                isReadOnlyGroups
                                  ? undefined
                                  : setAddToGroupSessionId
                              }
                              onRemoveFromGroup={
                                inGroup ? handleRemoveFromGroup : undefined
                              }
                              isInManualGroup={inGroup}
                              onCompact={
                                s.id === activeSessionId && onCompact
                                  ? () => setCompactDialogOpen(true)
                                  : undefined
                              }
                              compact={compactList}
                            />
                          );
                        })}
                      </div>
                    )}
                    {!isSessionSearchActive && isLoadingMore && (
                      <div className="flex items-center justify-center py-3 text-sm text-muted-foreground">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      </div>
                    )}
                    {!isSessionSearchActive && selectedView === "__all__" &&
                      !hasMore &&
                      sessions.length > 0 &&
                      !isLoading && (
                        <div className="py-3 text-center text-xs text-muted-foreground/40">
                          没有更多了
                        </div>
                      )}
                  </div>
                </ScrollArea>
              </>
            )}
          </div>
        )}
      </div>

      {/* 子栏拖动条:贴 aside 右边线,控制 subPanelWidth */}
      {(subPanelOpen || (showTrash && isAdmin)) && (
        <div
          className="group absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize"
          onMouseDown={onSubResizeMouseDown}
          onDoubleClick={onSubResizeDoubleClick}
          title="拖动调整会话列表宽度,双击恢复默认"
        >
          <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-primary/50" />
        </div>
      )}

      <SidebarDialogs
        sessions={sessions}
        groups={groupsHook.groups}
        onRename={onRename}
        renameSessionId={renameSessionId}
        setRenameSessionId={setRenameSessionId}
        renameGroupId={renameGroupId}
        setRenameGroupId={setRenameGroupId}
        deleteGroupId={deleteGroupId}
        setDeleteGroupId={setDeleteGroupId}
        handleRenameGroup={handleRenameGroup}
        handleDeleteGroup={handleDeleteGroup}
        addToGroupSessionId={addToGroupSessionId}
        setAddToGroupSessionId={setAddToGroupSessionId}
        allGroups={allGroups}
        handleAddToExistingGroup={handleAddToExistingGroup}
        handleCreateGroupAndAdd={handleCreateGroupAndAdd}
        addSessionsGroupKey={addSessionsGroupKey}
        setAddSessionsGroupKey={setAddSessionsGroupKey}
        addSessionsExistingSessionIds={
          addSessionsGroupKey && currentRealGroup
            ? new Set(currentRealGroup.sessionIds)
            : new Set()
        }
        handleAddSessionsToGroup={handleAddSessionsToGroup}
        showPasswordDialog={showPasswordDialog}
        setShowPasswordDialog={setShowPasswordDialog}
        compactDialogOpen={compactDialogOpen}
        setCompactDialogOpen={setCompactDialogOpen}
        onCompact={onCompact}
      />
    </aside>
  );
}
