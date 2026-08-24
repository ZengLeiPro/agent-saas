import { Bot, Clock, Minus, Plus, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EntityIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { AppTab } from "@/types/sidebar";

export const NAV_ITEM_SELECTED =
  "relative bg-brand-accent-soft text-foreground font-semibold " +
  "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 " +
  "before:h-5 before:w-[3px] before:rounded-r-full before:bg-brand-accent";
export const NAV_ITEM_UNSELECTED =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

interface SidebarNavProps {
  navItems: Array<{ tab: AppTab; label: string }>;
  activeTab: AppTab;
  isNewSessionActive: boolean;
  isLoading: boolean;
  onNew: (groupId?: string | null) => void;
  onTabChange?: (tab: AppTab) => void;
  beforeNavigate?: () => void;
  constrainNewButton?: boolean;
}

function getNavIcon(tab: AppTab) {
  if (tab === "profile") return Bot;
  if (tab === "capabilities") return EntityIcons.capabilityCenter;
  if (tab === "settings") return Settings2;
  if (tab === "cron") return Clock;
  if (tab === "mcp") return EntityIcons.connector;
  return null;
}

export function SidebarNav({ navItems, activeTab, isNewSessionActive, isLoading, onNew, onTabChange, beforeNavigate, constrainNewButton = true }: SidebarNavProps) {
  if (!onTabChange) return null;
  return (
    <nav className="flex flex-col gap-1 px-2 pb-3">
      <div className={cn("flex items-stretch gap-1", constrainNewButton && "max-w-[200px]")}>
        <button
          type="button"
          onClick={() => {
            beforeNavigate?.();
            onNew(null);
            if (activeTab !== "chat") onTabChange("chat");
          }}
          disabled={isLoading}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors",
            isNewSessionActive ? NAV_ITEM_SELECTED : NAV_ITEM_UNSELECTED,
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          <Plus className="size-4" />
          <span>新建会话</span>
        </button>
      </div>
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
            {Icon && <Icon className="size-4" />}
            {label}
          </button>
        );
      })}
    </nav>
  );
}

export function SessionSelectionActions({
  selectAllState,
  selectedCount,
  canDelete,
  canMove,
  onToggleAll,
  onCancel,
  onDelete,
  onMove,
}: {
  selectAllState: boolean | "indeterminate";
  selectedCount: number;
  canDelete: boolean;
  canMove: boolean;
  onToggleAll: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onMove: () => void;
}) {
  const allSelected = selectAllState === true;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <label className="flex h-8 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent" title={allSelected ? "取消全选当前列表" : "全选当前列表"}>
        <span className="relative flex size-4 shrink-0">
          <Checkbox checked={selectAllState} onCheckedChange={onToggleAll} aria-label={allSelected ? "取消全选当前列表" : "全选当前列表"} className={selectAllState === "indeterminate" ? "[&>span]:hidden" : undefined} />
          {selectAllState === "indeterminate" && <Minus className="pointer-events-none absolute inset-0 size-4 text-primary-foreground" />}
        </span>
        <span className="min-w-3 tabular-nums">{selectedCount}</span>
      </label>
      <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onCancel}>取消</Button>
      <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs text-destructive hover:text-destructive" disabled={!canDelete || selectedCount === 0} onClick={onDelete}>删除</Button>
      <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={!canMove || selectedCount === 0} onClick={onMove}>移动</Button>
    </div>
  );
}
