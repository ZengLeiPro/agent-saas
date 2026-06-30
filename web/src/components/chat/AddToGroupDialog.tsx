import { useCallback, useState } from "react";
import { Plus, FolderClosed } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { SessionGroup } from "@/types/sessionGroup";

interface AddToGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All existing groups (cron + manual) for display */
  allGroups: SessionGroup[];
  onAddToExistingGroup: (groupKey: string) => void;
  onCreateGroupAndAdd: (groupName: string) => void;
}

export function AddToGroupDialog({
  open,
  onOpenChange,
  allGroups,
  onAddToExistingGroup,
  onCreateGroupAndAdd,
}: AddToGroupDialogProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const handleClose = useCallback((isOpen: boolean) => {
    if (!isOpen) {
      setCreating(false);
      setNewName("");
    }
    onOpenChange(isOpen);
  }, [onOpenChange]);

  const handleCreate = useCallback(() => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onCreateGroupAndAdd(trimmed);
    handleClose(false);
  }, [newName, onCreateGroupAndAdd, handleClose]);

  const handleSelectGroup = useCallback((groupKey: string) => {
    onAddToExistingGroup(groupKey);
    handleClose(false);
  }, [onAddToExistingGroup, handleClose]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>添加到分组</DialogTitle>
          <DialogDescription>选择一个分组或创建新分组</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1 max-h-80 overflow-y-auto">
          {allGroups.map((group) => (
            <button
              key={group.groupKey}
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-accent text-left"
              onClick={() => handleSelectGroup(group.groupKey)}
            >
              <FolderClosed className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">{group.name}</span>
              {group.kind === "cron" && (
                <span className="shrink-0 text-xs text-muted-foreground">cron</span>
              )}
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{group.count}</span>
            </button>
          ))}

          {allGroups.length === 0 && !creating && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              暂无分组
            </div>
          )}
        </div>

        {creating ? (
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="分组名称"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") { setCreating(false); setNewName(""); }
              }}
            />
            <Button onClick={handleCreate} disabled={!newName.trim()}>
              确定
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setCreating(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            新建分组
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
