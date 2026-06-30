import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface SkillToggleItemProps {
  name: string;
  description: string;
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  badge?: string;
  disabled?: boolean;
}

export function SkillToggleItem({ name, description, checked, onCheckedChange, badge, disabled }: SkillToggleItemProps) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {badge && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {badge}
            </span>
          )}
        </div>
        {description && (
          <p className={cn("mt-1 text-xs text-muted-foreground", "line-clamp-2")}>
            {description}
          </p>
        )}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="shrink-0"
      />
    </div>
  );
}
