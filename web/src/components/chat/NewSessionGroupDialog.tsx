import { MessageSquare } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SessionGroup } from "@/types/sessionGroup";
import { SessionGroupGlyph } from "@/components/sessionGroupPresentation";

interface NewSessionGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: SessionGroup[];
  onSelect: (groupId: string | null) => void;
}

export function NewSessionGroupDialog({
  open,
  onOpenChange,
  groups,
  onSelect,
}: NewSessionGroupDialogProps) {
  const manualGroups = groups.filter((group) => group.kind === "manual");

  const handleSelect = (groupId: string | null) => {
    onOpenChange(false);
    onSelect(groupId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
          <DialogDescription>选择新会话所属分组，系统分组仍由对应任务自动维护。</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
            onClick={() => handleSelect(null)}
          >
            <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">不分组</span>
          </button>
          {manualGroups.map((group) => (
            <button
              key={group.groupKey}
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
              onClick={() => handleSelect(group.groupKey)}
            >
              <SessionGroupGlyph kind={group.kind} className="size-4" />
              <span className="truncate">{group.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{group.count}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
