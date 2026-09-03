import { type MouseEventHandler, type ReactNode } from "react";
import { ChevronLeft, CircleAlert, Loader2 } from "lucide-react";

import { PanelToggleIcon } from "@/components/icons/PanelToggleIcon";
import { NAV_ITEM_SELECTED, NAV_ITEM_UNSELECTED } from "@/components/DesktopSessionSidebarControls";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { ANALYSIS_NAVIGATION } from "@/lib/analysisNavigation";
import { managementPageForRoute } from '@/lib/managementNavigation';
import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import { EntityIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";

export interface UnifiedAnalysisSidebarProps {
  width: number;
  hidden: boolean;
  className?: string;
  access: ManagementSettingsAccess;
  route: GovernanceRouteState;
  onNavigate?: (routeId: string) => void;
  onClose?: () => void;
  onCollapse?: () => void;
  onResizeMouseDown: MouseEventHandler<HTMLDivElement>;
  onResizeDoubleClick: MouseEventHandler<HTMLDivElement>;
  footer: ReactNode;
}

export function UnifiedAnalysisSidebar({
  width,
  hidden,
  className,
  access,
  route,
  onNavigate,
  onClose,
  onCollapse,
  onResizeMouseDown,
  onResizeDoubleClick,
  footer,
}: UnifiedAnalysisSidebarProps) {
  const groups = ANALYSIS_NAVIGATION.filter((group) => (
    group.scope === "platform" ? access.platformEntryAllowed : access.tenantEntryAllowed
  ));
  const activePageId = managementPageForRoute(route)?.id;

  return (
    <aside
      className={cn("relative flex h-full shrink-0 flex-col bg-background", hidden && "hidden", className)}
      style={{ width }}
      data-testid="unified-analysis-sidebar"
      // @ts-expect-error -- inert is a valid HTML attribute, React types lag behind
      inert={hidden ? "" : undefined}
    >
      <div className="flex h-[60px] shrink-0 items-center gap-2 px-3">
        <button type="button" className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={onClose} aria-label="返回主界面" title="返回主界面">
          <ChevronLeft className="size-5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <EntityIcons.analytics className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold tracking-tight">分析</span>
        </div>
        {onCollapse && (
          <button type="button" className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={onCollapse} title="收起侧边栏">
            <PanelToggleIcon className="size-5" />
          </button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1" aria-label="分析导航">
        <nav className="flex flex-col gap-6 px-2 pb-4 pt-1">
          {(access.status === "loading" || access.status === "refreshing") && (
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" />
              <span>{access.status === "refreshing" ? "正在更新分析权限…" : "正在验证分析权限…"}</span>
            </div>
          )}
          {access.status === "error" && (
            <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10" onClick={access.retry}>
              <CircleAlert className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">分析权限验证失败</span>
              <span className="text-xs font-medium">重试</span>
            </button>
          )}
          {groups.map((group) => (
            <div key={group.scope}>
              <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">{group.label}</div>
              <div className="flex flex-col gap-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = activePageId === item.pageId;
                  return (
                    <button key={item.routeId} type="button" className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-medium transition-colors", active ? NAV_ITEM_SELECTED : NAV_ITEM_UNSELECTED)} aria-current={active ? "page" : undefined} onClick={() => onNavigate?.(item.routeId)}>
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </ScrollArea>

      {footer}
      <div className="group absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize" onMouseDown={onResizeMouseDown} onDoubleClick={onResizeDoubleClick} title="拖动调整侧边栏宽度,双击恢复默认">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-primary/50" />
      </div>
    </aside>
  );
}
