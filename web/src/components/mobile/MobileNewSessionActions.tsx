import { FolderPlus, Plus } from "lucide-react";

import { NewSessionGroupDialog } from "@/components/chat/NewSessionGroupDialog";
import type { SessionGroup } from "@/types/sessionGroup";

export function MobileNewSessionActions({
  groups,
  isLoading,
  pickerOpen,
  onPickerOpenChange,
  onNew,
}: {
  groups: SessionGroup[];
  isLoading: boolean;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  onNew: (groupId?: string | null) => void;
}) {
  const hasManualGroups = groups.some((group) => group.kind === "manual");
  return (
    <>
      {hasManualGroups && (
        <button
          type="button"
          aria-label="新建到分组"
          title="新建到分组"
          onClick={() => onPickerOpenChange(true)}
          disabled={isLoading}
          className="absolute right-5 z-10 flex size-10 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-md transition-transform active:scale-95 disabled:opacity-50"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 3.5rem)" }}
        >
          <FolderPlus className="size-5" />
        </button>
      )}
      <button
        type="button"
        aria-label="新建会话"
        onClick={() => onNew(null)}
        disabled={isLoading}
        className="absolute right-4 z-10 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95 disabled:opacity-50"
        style={{ bottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <Plus className="size-6" />
      </button>
      <NewSessionGroupDialog
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        groups={groups}
        onSelect={onNew}
      />
    </>
  );
}
