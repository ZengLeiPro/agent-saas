import type { LucideIcon } from 'lucide-react';

export interface ManagementSettingsGroup {
  id: string;
  label: string;
  items: readonly {
    id: string;
    label: string;
    icon: LucideIcon;
    onSelect: () => void;
  }[];
}

export function ManagementSettingsGroups({
  groups,
  onSelect,
}: {
  groups: readonly ManagementSettingsGroup[];
  onSelect: (navigation: () => void) => void;
}) {
  return groups.map((group) => (
    <div key={group.id} className="mb-4">
      <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">{group.label}</div>
      <div className="space-y-1">
        {group.items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              onClick={() => onSelect(item.onSelect)}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  ));
}
