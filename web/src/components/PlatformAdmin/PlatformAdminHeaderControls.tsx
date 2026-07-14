import { BarChart3, Gauge, HardDrive, ListTree, MessageSquareText, ServerCog, Users, type LucideIcon } from "lucide-react";
import { EntityIcons } from "@/lib/icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PlatformAdminSection } from "@/lib/urlSync";

import { PlatformAdminSearch } from "./PlatformAdminSearch";
import { RUN_SHORT_LABEL } from "./displayText";

interface PlatformAdminNavItem {
  id: PlatformAdminSection;
  label: string;
  icon: LucideIcon;
}

export const platformAdminSections: PlatformAdminNavItem[] = [
  { id: "overview", label: "概览", icon: Gauge },
  { id: "tenants", label: "租户", icon: EntityIcons.org },
  { id: "users", label: "用户", icon: Users },
  { id: "sessions", label: "会话", icon: MessageSquareText },
  { id: "runs", label: RUN_SHORT_LABEL, icon: ListTree },
  { id: "sandboxes", label: "执行环境", icon: ServerCog },
  { id: "infra", label: "基础设施", icon: HardDrive },
  { id: "audit", label: "审计", icon: EntityIcons.audit },
  { id: "efficiency", label: "效率", icon: BarChart3 },
];

export function PlatformAdminHeaderControls({
  active,
  onActiveChange,
  className,
  searchClassName,
}: {
  active: PlatformAdminSection;
  onActiveChange: (section: PlatformAdminSection) => void;
  className?: string;
  searchClassName?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="平台分析分区">
        {platformAdminSections.map(item => {
          const Icon = item.icon;
          const selected = item.id === active;
          return (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={selected ? "default" : "ghost"}
              onClick={() => onActiveChange(item.id)}
              className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </Button>
          );
        })}
      </nav>
      <div className={cn("w-[min(34vw,30rem)] min-w-[260px] shrink-0", searchClassName)}>
        <PlatformAdminSearch />
      </div>
    </div>
  );
}
