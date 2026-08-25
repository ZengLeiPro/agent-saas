import { useMemo, type MouseEventHandler, type ReactNode } from "react";
import { ChevronLeft, Settings2 } from "lucide-react";

import { PanelToggleIcon } from "@/components/icons/PanelToggleIcon";
import { SETTINGS_SECTIONS } from "@/components/SettingsCenter/settingsConfig";
import { PLATFORM_SETTINGS_SECTIONS, TENANT_SETTINGS_SECTIONS } from "@/components/SettingsCenter/unifiedSettingsConfig";
import { NAV_ITEM_SELECTED, NAV_ITEM_UNSELECTED } from "@/components/DesktopSessionSidebarControls";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { AdminSettingsTarget } from "@/lib/urlSync";

export interface UnifiedSettingsSidebarProps {
  width: number;
  hidden: boolean;
  className?: string;
  isAdmin: boolean;
  isPlatformAdmin: boolean;
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
  width, hidden, className, isAdmin, isPlatformAdmin, personalAgentEnabled,
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
    ...(isAdmin ? [{ id: "tenant" as const, label: "组织管理", items: TENANT_SETTINGS_SECTIONS }] : []),
    ...(isPlatformAdmin ? [{ id: "platform" as const, label: "平台管理", items: PLATFORM_SETTINGS_SECTIONS }] : []),
  ], [isAdmin, isPlatformAdmin, personalAgentEnabled]);

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

      <ScrollArea className="min-h-0 flex-1" aria-label="设置导航">
        <nav className="flex flex-col gap-4 px-2 pb-4 pt-1">
          {groups.map((group) => (
            <div key={group.id}>
              <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">{group.label}</div>
              <div className="flex flex-col gap-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = target === group.id && activeSection === item.id;
                  return (
                    <button key={`${group.id}:${item.id}`} type="button" className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-medium transition-colors", active ? NAV_ITEM_SELECTED : NAV_ITEM_UNSELECTED)} aria-current={active ? "page" : undefined} onClick={() => onNavigate?.(group.id, item.id)}>
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
