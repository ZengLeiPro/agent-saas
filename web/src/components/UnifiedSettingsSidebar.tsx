import { Fragment, useMemo, useState, type MouseEventHandler, type ReactNode } from "react";
import {
  ChevronDown, ChevronLeft, CircleAlert, Database, FileStack, Globe2, KeyRound, Layers3,
  Loader2, LockKeyhole, Palette, Search, Settings2, SlidersHorizontal,
  UserMinus, type LucideIcon,
} from "lucide-react";

import { PanelToggleIcon } from "@/components/icons/PanelToggleIcon";
import { SETTINGS_SECTIONS } from "@/components/SettingsCenter/settingsConfig";
import { NAV_ITEM_SELECTED, NAV_ITEM_UNSELECTED } from "@/components/DesktopSessionSidebarControls";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EntityIcons } from '@/lib/icons';
import { cn } from "@/lib/utils";
import type { AdminSettingsTarget } from "@/lib/urlSync";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { managementPagesFor } from "@/lib/managementNavigation";

const MANAGEMENT_ICONS: Readonly<Record<string, LucideIcon>> = {
  bot: EntityIcons.expert,
  building: EntityIcons.org,
  clock: EntityIcons.cron,
  cpu: EntityIcons.model,
  database: Database,
  globe: Globe2,
  groups: Layers3,
  key: KeyRound,
  'layout-template': FileStack,
  lock: LockKeyhole,
  message: EntityIcons.systemPrompts,
  palette: Palette,
  plug: EntityIcons.connector,
  scroll: EntityIcons.audit,
  search: Search,
  settings: Settings2,
  shield: EntityIcons.admin,
  sliders: SlidersHorizontal,
  sparkles: EntityIcons.skill,
  'user-minus': UserMinus,
  users: EntityIcons.members,
  wallet: EntityIcons.billing,
  workflow: EntityIcons.workflow,
  wrench: EntityIcons.toolControls,
};

function managementItems(area: 'organization' | 'platform') {
  return managementPagesFor('config', area).map((page) => ({
    id: page.id,
    label: page.label,
    group: page.group,
    icon: MANAGEMENT_ICONS[page.iconKey] ?? Settings2,
  }));
}

export interface UnifiedSettingsSidebarProps {
  width: number;
  hidden: boolean;
  className?: string;
  access: ManagementSettingsAccess;
  personalAgentEnabled: boolean;
  target: "personal" | AdminSettingsTarget;
  activeSection: string;
  onNavigate?: (target: "personal" | AdminSettingsTarget, section: string) => void;
  onClose?: () => void;
  onCollapse?: () => void;
  onResizeMouseDown: MouseEventHandler<HTMLDivElement>;
  onResizeDoubleClick: MouseEventHandler<HTMLDivElement>;
  footer: ReactNode;
}

export function UnifiedSettingsSidebar({
  width, hidden, className, access, personalAgentEnabled,
  target, activeSection, onNavigate, onClose, onCollapse,
  onResizeMouseDown, onResizeDoubleClick, footer,
}: UnifiedSettingsSidebarProps) {
  const groups = useMemo(() => [
    {
      id: "personal" as const,
      label: "个人设置",
      items: SETTINGS_SECTIONS
        .filter((item) => personalAgentEnabled || item.id !== "my-agent")
        .map((item) => ({ id: item.id, label: item.label, icon: item.icon })),
    },
    ...((access.status === "ready" || access.status === "refreshing") && access.tenantEntryAllowed ? [{ id: "tenant" as const, label: "组织管理", items: managementItems('organization') }] : []),
    ...((access.status === "ready" || access.status === "refreshing") && access.platformEntryAllowed ? [{ id: "platform" as const, label: "平台运营", items: managementItems('platform') }] : []),
  ], [access.platformEntryAllowed, access.status, access.tenantEntryAllowed, personalAgentEnabled]);
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const visibleGroups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return groups;
    return groups.map((group) => {
      if (group.label.toLowerCase().includes(needle)) return group;
      return {
        ...group,
        items: group.items.filter((item) => {
          const itemGroup = "group" in item ? item.group : "";
          return `${item.label} ${itemGroup}`.toLowerCase().includes(needle);
        }),
      };
    }).filter((group) => group.items.length > 0);
  }, [groups, search]);

  return (
    <aside
      className={cn("relative flex h-full shrink-0 flex-col bg-background", hidden && "hidden", className)}
      style={{ width }}
      data-testid="unified-settings-sidebar"
      // @ts-expect-error -- inert is a valid HTML attribute, React types lag behind
      inert={hidden ? "" : undefined}
    >
      <div className="flex h-[60px] shrink-0 items-center gap-2 px-3">
        <button type="button" className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={onClose} aria-label="返回主界面" title="返回主界面">
          <ChevronLeft className="size-5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Settings2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold tracking-tight">设置</span>
        </div>
        {onCollapse && (
          <button type="button" className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={onCollapse} title="收起侧边栏">
            <PanelToggleIcon className="size-5" />
          </button>
        )}
      </div>

      <div className="shrink-0 px-3 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id="unified-settings-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索设置"
            aria-label="搜索设置"
            className="h-9 w-full rounded-lg border bg-background pl-8 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" aria-label="设置导航">
        <nav className="flex flex-col gap-6 px-2 pb-4 pt-1">
          {(access.status === "loading" || access.status === "refreshing") && (
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" />
              <span>{access.status === "refreshing" ? "正在更新管理权限…" : "正在验证管理权限…"}</span>
            </div>
          )}
          {access.status === "error" && (
            <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10" onClick={access.retry}>
              <CircleAlert className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">管理权限验证失败</span>
              <span className="text-xs font-medium">重试</span>
            </button>
          )}
          {visibleGroups.map((group) => {
            const activeGroup = target === group.id;
            const collapsed = !search.trim() && Boolean(collapsedGroups[group.id]) && !activeGroup;
            return (
              <div key={group.id}>
                <button
                  type="button"
                  className="mb-1 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-expanded={!collapsed}
                  aria-controls={`unified-settings-group-${group.id}`}
                  onClick={() => setCollapsedGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}
                >
                  <span>{group.label}</span>
                  <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", collapsed && "-rotate-90")} />
                </button>
                <div id={`unified-settings-group-${group.id}`} className="flex flex-col gap-1" hidden={collapsed}>
                  {group.items.map((item, index) => {
                    const Icon = item.icon;
                    const active = target === group.id && activeSection === item.id;
                    const itemGroup = 'group' in item ? item.group : null;
                    const previous = index > 0 ? group.items[index - 1] : null;
                    const previousGroup = previous && 'group' in previous ? previous.group : null;
                    return (
                      <Fragment key={`${group.id}:${item.id}`}>
                        {itemGroup && itemGroup !== previousGroup ? (
                          <div className="px-2 pb-1 pt-3 text-[11px] font-medium text-muted-foreground/70 first:pt-1">{itemGroup}</div>
                        ) : null}
                        <button type="button" className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-medium transition-colors", active ? NAV_ITEM_SELECTED : NAV_ITEM_UNSELECTED)} aria-current={active ? "page" : undefined} onClick={() => onNavigate?.(group.id, item.id)}>
                          <Icon className="size-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        </button>
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {visibleGroups.length === 0 && <div className="px-2 py-6 text-center text-xs text-muted-foreground" role="status">没有匹配的设置</div>}
        </nav>
      </ScrollArea>

      {footer}
      <div className="group absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize" onMouseDown={onResizeMouseDown} onDoubleClick={onResizeDoubleClick} title="拖动调整侧边栏宽度,双击恢复默认">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-primary/50" />
      </div>
    </aside>
  );
}
