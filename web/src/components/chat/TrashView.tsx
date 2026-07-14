import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, RotateCcw, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authFetch } from "@/lib/authFetch";
import type { ApiSessionListItem } from "@agent/shared";

interface TrashViewProps {
  onClose: () => void;
  onPreviewSession?: (sessionId: string) => void;
  activePreviewId?: string | null;
  showHeader?: boolean;
}

function formatDeletedTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return d.toLocaleDateString("zh-CN");
}

export function TrashView({ onClose, onPreviewSession, activePreviewId, showHeader = true }: TrashViewProps) {
  const [sessions, setSessions] = useState<ApiSessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [permanentDeleteId, setPermanentDeleteId] = useState<string | null>(null);

  const loadTrash = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authFetch("/api/sessions/trash");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (err) {
      console.error("加载回收站失败:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadTrash(); }, [loadTrash]);

  const handleRestore = useCallback(async (sessionId: string) => {
    setActionLoading(sessionId);
    try {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, { method: "POST" });
      if (res.ok) {
        setSessions(prev => prev.filter(s => s.sessionId !== sessionId));
      } else {
        alert("恢复失败");
      }
    } catch {
      alert("恢复失败");
    } finally {
      setActionLoading(null);
    }
  }, []);

  const handlePermanentDelete = useCallback(async () => {
    if (!permanentDeleteId) return;
    setActionLoading(permanentDeleteId);
    try {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(permanentDeleteId)}/permanent`, { method: "DELETE" });
      if (res.ok) {
        setSessions(prev => prev.filter(s => s.sessionId !== permanentDeleteId));
      } else {
        alert("删除失败");
      }
    } catch {
      alert("删除失败");
    } finally {
      setActionLoading(null);
      setPermanentDeleteId(null);
    }
  }, [permanentDeleteId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showHeader && (
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
          <Trash2 className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">回收站</span>
          <span className="text-xs text-muted-foreground">({sessions.length})</span>
        </div>
      )}

      {/* List */}
      <ScrollArea className="flex-1 [&_[style*=table]]:!block">
        <div className="px-2 pb-4 pt-1">
          {loading ? (
            <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中...
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              回收站为空
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {sessions.map(s => (
                <div
                  key={s.sessionId}
                  className={`group flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent ${activePreviewId === s.sessionId ? "bg-accent" : ""}`}
                  onClick={() => onPreviewSession?.(s.sessionId)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {s.title || "无标题"}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {s.deletedAt && <span>{formatDeletedTime(s.deletedAt)}</span>}
                    </div>
                    {s.preview && (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground/70">
                        {s.preview}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      title="恢复"
                      disabled={actionLoading === s.sessionId}
                      onClick={(e) => { e.stopPropagation(); void handleRestore(s.sessionId); }}
                      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50"
                    >
                      <RotateCcw className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="永久删除"
                      disabled={actionLoading === s.sessionId}
                      onClick={(e) => { e.stopPropagation(); setPermanentDeleteId(s.sessionId); }}
                      className="rounded-md p-1.5 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Permanent delete confirmation dialog */}
      <Dialog open={permanentDeleteId !== null} onOpenChange={(open) => { if (!open) setPermanentDeleteId(null); }}>
        <DialogContent onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handlePermanentDelete(); } }}>
          <DialogHeader>
            <DialogTitle>永久删除</DialogTitle>
            <DialogDescription>
              确定要永久删除这个会话吗？此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPermanentDeleteId(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handlePermanentDelete()}>
              永久删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
