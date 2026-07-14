import { Gauge, MessageSquareText, type LucideIcon } from "lucide-react";
import { EntityIcons } from "@/lib/icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TenantSection } from "@/components/AdminShells";

interface TenantAdminNavItem {
  id: Extract<TenantSection, "overview" | "usage" | "qa" | "audit">;
  label: string;
  icon: LucideIcon;
}

const tenantAdminSections: TenantAdminNavItem[] = [
  { id: "overview", label: "综合分析", icon: Gauge },
  { id: "usage", label: "用量与配额", icon: EntityIcons.analytics },
  { id: "qa", label: "对话质检", icon: MessageSquareText },
  { id: "audit", label: "审计", icon: EntityIcons.audit },
];

export function TenantAdminHeaderControls({
  active,
  onActiveChange,
  className,
}: {
  active: TenantSection;
  onActiveChange: (section: TenantSection) => void;
  className?: string;
}) {
  return (
    <nav className={cn("flex min-w-0 items-center gap-1 overflow-x-auto", className)} aria-label="组织分析分区">
      {tenantAdminSections.map(item => {
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
            <Icon className="size-3.5" />
            {item.label}
          </Button>
        );
      })}
    </nav>
  );
}
