/**
 * 左栏会话行（从 `DesktopSessionSidebar.tsx` 原样抽出，逻辑逐行未改）。
 *
 * 抽出动机：WP4 要在左栏加「定制软件」标签，而 `DesktopSessionSidebar.tsx`
 * 的 max-lines 基线余量为 0（2377/2377），必须先做等行数替换腾出空间。
 * 这三个组件（`SessionLeadingIcon` / `CompactSessionLeadingIcon` / `SessionRow`）
 * 是文件内最大的一块纯 props、无闭包依赖的内聚区，抽走即净减。
 */
import { lazy, Suspense } from 'react';
import {
  Bot,
  Check,
  FolderMinus,
  FolderPlus,
  Loader2,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react';

import { AgentAvatar } from '@/components/AgentAvatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatSessionIndexItem } from '@/types/sidebar';
import { formatShortDate, getSessionWaitingLabel } from '@/types/sidebar';

const SessionAutomationBadge = lazy(() => import('@/components/SessionAutomationBadge'));

/* ------------------------------------------------------------------ */
/*  SessionRow: 复用的会话行                                           */
/* ------------------------------------------------------------------ */
function SessionLeadingIcon({
  session,
  selected = false,
}: {
  session: ChatSessionIndexItem;
  selected?: boolean;
}) {
  if (selected) {
    return (
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"
        aria-hidden="true"
      >
        <Check className="size-5" strokeWidth={2.5} />
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
      <span
        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"
        aria-hidden="true"
      >
        <Check className="size-3" strokeWidth={2.5} />
      </span>
    );
  }
  return <MessageSquare className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />;
}
export function SessionRow({
  session,
  active,
  metaText,
  isLoading,
  onSelect,
  onDelete,
  onRename,
  onAutoTitle,
  onShare,
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
  onShare?: (sessionId: string) => void;
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
  const waitingLabel = getSessionWaitingLabel(session.runtimeStatus);
  const hasMenu =
    !selectionMode &&
    Boolean(
      onDelete ||
      onRename ||
      onAutoTitle ||
      onShare ||
      onAddToGroup ||
      onRemoveFromGroup ||
      onCompact,
    );

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
          <Pencil className="size-3.5" />
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
          <Sparkles className="size-3.5" />
          自动命名
        </button>
      )}
      {onShare && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            setActionMenuId(null);
            onShare(session.id);
          }}
        >
          <Share2 className="size-3.5" />
          分享
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
          <FolderPlus className="size-3.5" />
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
          <FolderMinus className="size-3.5" />
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
          <Minimize2 className="size-3.5" />
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
          <Trash2 className="size-3.5" />
          删除
        </button>
      )}
    </div>
  ) : null;

  if (compact) {
    return (
      <div
        className={cn(
          'group relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors',
          active ? 'bg-brand-accent-soft' : 'hover:bg-muted',
          menuOpen && 'z-10',
        )}
        onClick={() => onSelect(session.id)}
      >
        <CompactSessionLeadingIcon selected={selected} />
        {session.hasUnreadAiReply && (
          <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5">
          {session.title || '新会话'}
        </span>
        <Suspense fallback={null}>
          <SessionAutomationBadge session={session} compact />
        </Suspense>
        {session.agentTarget?.kind === 'org-agent' && (
          <span
            className="flex max-w-24 shrink-0 items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-600 dark:bg-brand-900/35 dark:text-brand-300"
            title={session.orgAgentName || '企业专家'}
            aria-label={`企业专家：${session.orgAgentName || '企业专家'}`}
          >
            <Bot className="size-3" />
            <span className="truncate">{session.orgAgentName || '企业专家'}</span>
          </span>
        )}
        <span
          className={cn(
            'shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground/60 transition-opacity',
            hasMenu && 'group-hover:opacity-0',
            hasMenu && menuOpen && 'opacity-0',
          )}
        >
          {waitingLabel ? (
            <span className="font-medium text-warning" aria-label={`会话${waitingLabel}`}>
              {waitingLabel}
            </span>
          ) : session.isRunning ? (
            <Loader2 className="size-3.5 animate-spin text-blue-500" aria-label="会话运行中" />
          ) : (
            formatShortDate(session.updatedAt)
          )}
        </span>
        {hasMenu && (
          <div
            className={cn(
              'absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
              menuOpen && 'opacity-100',
            )}
            ref={menuOpen ? actionMenuRef : undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={(e) => {
                e.stopPropagation();
                setActionMenuId(menuOpen ? null : session.id);
              }}
              disabled={isLoading}
            >
              <MoreHorizontal className="size-3.5 text-muted-foreground" />
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
        'group relative cursor-pointer rounded-lg px-3 py-3 transition-colors',
        active ? 'bg-brand-accent-soft' : 'hover:bg-muted',
        menuOpen && 'z-10',
      )}
      onClick={() => onSelect(session.id)}
    >
      <div className="flex min-w-0 items-center gap-3 pr-8">
        <SessionLeadingIcon session={session} selected={selected} />
        <div className={cn('min-w-0 flex-1', singleColumn && '-translate-y-0.5')}>
          <div className="flex min-w-0 items-center text-sm font-medium leading-snug">
            {session.hasUnreadAiReply && (
              <span
                className="mr-1 flex w-4 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <span className="size-1.5 rounded-full bg-destructive" />
              </span>
            )}
            <span className="truncate">{session.title || '新会话'}</span>
            {session.agentTarget?.kind === 'org-agent' && (
              <span
                className="ml-1 flex size-4 shrink-0 items-center justify-center rounded bg-brand-50 text-brand-600 dark:bg-brand-900/35 dark:text-brand-300"
                title={session.orgAgentName || '企业专家'}
                aria-label={`企业专家：${session.orgAgentName || '企业专家'}`}
              >
                <Bot className="size-3" />
              </span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground/60">
            <Suspense fallback={null}>
              <SessionAutomationBadge session={session} separator={Boolean(metaText)} />
            </Suspense>
            <span className="block min-w-0 truncate pr-28">{metaText}</span>
          </div>
        </div>
      </div>
      <span
        className={cn(
          'pointer-events-none absolute right-2 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground/60',
          singleColumn ? 'bottom-2.5' : 'bottom-3',
        )}
      >
        {waitingLabel ? (
          <span className="font-medium text-warning" aria-label={`会话${waitingLabel}`}>
            {waitingLabel}
          </span>
        ) : session.isRunning ? (
          <Loader2 className="size-3.5 animate-spin text-blue-500" aria-label="会话运行中" />
        ) : (
          formatShortDate(session.updatedAt)
        )}
      </span>

      {/* 省略号操作菜单 */}
      {hasMenu && (
        <div className="absolute right-1 top-2" ref={menuOpen ? actionMenuRef : undefined}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={(e) => {
              e.stopPropagation();
              setActionMenuId(menuOpen ? null : session.id);
            }}
            disabled={isLoading}
          >
            <MoreHorizontal className="size-3.5 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
          </Button>

          {menuDropdown}
        </div>
      )}
    </div>
  );
}
