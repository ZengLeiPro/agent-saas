import { useCallback, useMemo, useState } from "react";
import { Search, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ChatSessionIndexItem } from "@/types/sidebar";
import { formatShortDate, sourceDisplayText } from "@/types/sidebar";
import { cn } from "@/lib/utils";

interface AddSessionsToGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All available sessions */
  allSessions: ChatSessionIndexItem[];
  /** Session IDs already in this group */
  existingSessionIds: Set<string>;
  onConfirm: (sessionIds: string[]) => void;
}

export function AddSessionsToGroupDialog({
  open,
  onOpenChange,
  allSessions,
  existingSessionIds,
  onConfirm,
}: AddSessionsToGroupDialogProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleClose = useCallback((isOpen: boolean) => {
    if (!isOpen) {
      setQuery("");
      setSelected(new Set());
    }
    onOpenChange(isOpen);
  }, [onOpenChange]);

  // Filter sessions not already in group, then by search query
  const availableSessions = useMemo(() => {
    let list = allSessions.filter((s) => !existingSessionIds.has(s.id));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((s) => s.title.toLowerCase().includes(q));
    }
    return list;
  }, [allSessions, existingSessionIds, query]);

  const toggleSession = useCallback((sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm(Array.from(selected));
    handleClose(false);
  }, [selected, onConfirm, handleClose]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加会话到分组</DialogTitle>
          <DialogDescription>选择要添加的会话</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话..."
            className="pl-8"
          />
        </div>

        <ScrollArea className="max-h-72">
          <div className="flex flex-col gap-0.5">
            {availableSessions.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {query.trim() ? "未找到匹配的会话" : "没有可添加的会话"}
              </div>
            ) : (
              availableSessions.map((s) => {
                const isSelected = selected.has(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={cn(
                      "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                      isSelected ? "bg-accent" : "hover:bg-accent/50",
                    )}
                    onClick={() => toggleSession(s.id)}
                  >
                    <div className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                      isSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30",
                    )}>
                      {isSelected && <Check className="size-3" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium leading-snug">
                        {s.title || "新会话"}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground/60">
                        <span>{sourceDisplayText(s.source)}</span>
                        <span>{formatShortDate(s.updatedAt)}</span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={selected.size === 0}>
            添加 {selected.size > 0 ? `(${selected.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
