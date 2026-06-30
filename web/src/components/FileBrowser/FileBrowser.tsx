import { useState, useCallback, useMemo } from "react";
import { RefreshCw, X, Loader2, FolderOpen, FolderTree, List, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { getPreviewFileType, FILE_SORT_LABELS } from "@agent/shared";
import type { FileEntry, FileSortKey, FileSortOrder } from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Breadcrumb } from "./Breadcrumb";
import { FileListItem } from "./FileListItem";
import { useFileList } from "./useFileList";

export interface FileBrowserProps {
  onClose?: () => void;
  onPreviewFile: (path: string, owner?: string) => void;
  owner?: string;
  fullPage?: boolean;
  reserveCloseButtonSpace?: boolean;
}

type ViewMode = "folder" | "all";

function sortEntries(entries: FileEntry[], sortKey: FileSortKey, sortOrder: FileSortOrder): FileEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    // 文件夹视图中目录始终在前
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;

    let cmp = 0;
    switch (sortKey) {
      case "name":
        cmp = a.name.localeCompare(b.name);
        break;
      case "modifiedAt":
        cmp = a.modifiedAt - b.modifiedAt;
        break;
      case "size":
        cmp = a.size - b.size;
        break;
      case "extension":
        cmp = a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name);
        break;
    }
    return sortOrder === "asc" ? cmp : -cmp;
  });
  return sorted;
}

const SORT_KEYS: FileSortKey[] = ["name", "modifiedAt", "size", "extension"];

const SORT_STORAGE_KEY = "files.sort";

interface SortPrefs {
  folder: { key: FileSortKey; order: FileSortOrder };
  all: { key: FileSortKey; order: FileSortOrder };
}

const DEFAULT_SORT: SortPrefs = {
  folder: { key: "modifiedAt", order: "desc" },
  all: { key: "modifiedAt", order: "desc" },
};

function loadSortPrefs(): SortPrefs {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<SortPrefs>;
      return {
        folder: { ...DEFAULT_SORT.folder, ...saved.folder },
        all: { ...DEFAULT_SORT.all, ...saved.all },
      };
    }
  } catch { /* ignore */ }
  return DEFAULT_SORT;
}

export function FileBrowser({ onClose, onPreviewFile, owner, fullPage, reserveCloseButtonSpace }: FileBrowserProps) {
  const { user: authUser } = useAuth();
  // 历史 admin OwnerPicker 已移除（任何角色都不允许查看他人文件目录，
  // 后端 /api/file/* 已收紧到 isPlatformAdmin + 同组织校验）。
  const effectiveOwner = owner ?? authUser?.username;

  const [currentPath, setCurrentPath] = useState("assets");
  const [viewMode, setViewMode] = useState<ViewMode>("folder");
  const [sortPrefs, setSortPrefs] = useState<SortPrefs>(loadSortPrefs);

  const sortKey = sortPrefs[viewMode].key;
  const sortOrder = sortPrefs[viewMode].order;

  const updateSort = useCallback((mode: ViewMode, key: FileSortKey, order: FileSortOrder) => {
    setSortPrefs(prev => {
      const next = { ...prev, [mode]: { key, order } };
      try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const listPath = viewMode === "all" ? "assets" : currentPath;
  const { entries: rawEntries, loading, error, refresh } = useFileList(listPath, effectiveOwner, viewMode === "all");

  const entries = useMemo(
    () => sortEntries(rawEntries, sortKey, sortOrder),
    [rawEntries, sortKey, sortOrder],
  );

  const handleSortClick = useCallback((key: FileSortKey) => {
    if (key === sortKey) {
      updateSort(viewMode, key, sortOrder === "asc" ? "desc" : "asc");
    } else {
      updateSort(viewMode, key, key === "modifiedAt" ? "desc" : "asc");
    }
  }, [sortKey, sortOrder, viewMode, updateSort]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const params = new URLSearchParams({ path: deleteTarget.path });
      if (effectiveOwner) params.set("owner", effectiveOwner);
      const res = await authFetch(`/api/file/delete?${params}`, { method: "DELETE" });
      if (res.ok) {
        refresh();
      }
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, effectiveOwner, refresh]);

  const handleEntryClick = useCallback((entry: FileEntry) => {
    if (entry.isDirectory) {
      setViewMode("folder");
      setCurrentPath(entry.path);
    } else if (getPreviewFileType(entry.name)) {
      onPreviewFile(entry.path, effectiveOwner);
    } else {
      const params = new URLSearchParams({ path: entry.path });
      if (effectiveOwner) params.set("owner", effectiveOwner);
      const url = `/api/file/download?${params}`;
      void authFetch(url).then(res => {
        if (res.ok) {
          const a = document.createElement("a");
          a.href = res.url;
          a.download = entry.name;
          a.target = "_blank";
          a.click();
        }
      });
    }
  }, [onPreviewFile, effectiveOwner]);

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Header */}
      <div className={cn("flex h-12 shrink-0 items-center gap-2 border-b px-3", reserveCloseButtonSpace && "pr-10")}>
        <div className="min-w-0 flex-1">
          {viewMode === "folder" ? (
            <Breadcrumb currentPath={currentPath} onNavigate={setCurrentPath} />
          ) : (
            <span className="text-sm font-medium">所有文件</span>
          )}
        </div>
        {/* 视图切换 */}
        <div className="flex shrink-0 rounded-md border">
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7 rounded-r-none", viewMode === "folder" && "bg-accent")}
            onClick={() => setViewMode("folder")}
            title="文件夹视图"
          >
            <FolderTree className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7 rounded-l-none border-l", viewMode === "all" && "bg-accent")}
            onClick={() => setViewMode("all")}
            title="所有文件"
          >
            <List className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={refresh} title="刷新">
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
        </Button>
        {!fullPage && onClose && (
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} title="关闭">
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        )}
      </div>

      {/* 排序栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1">
        <ArrowUpDown className="mr-1 h-3 w-3 text-muted-foreground/60" />
        {SORT_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={cn(
              "flex items-center gap-0.5 rounded px-2 py-0.5 text-xs transition-colors",
              sortKey === key
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
            onClick={() => handleSortClick(key)}
          >
            {FILE_SORT_LABELS[key]}
            {sortKey === key && (
              sortOrder === "asc"
                ? <ArrowUp className="h-3 w-3" />
                : <ArrowDown className="h-3 w-3" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={refresh}>重试</Button>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <FolderOpen className="h-10 w-10" />
          <p className="text-sm">暂无文件</p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-2">
            {entries.map((entry) => (
              <FileListItem
                key={entry.path}
                entry={entry}
                onClick={handleEntryClick}
                onDelete={setDeleteTarget}
                showPath={viewMode === "all"}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      {/* 删除确认对话框 */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              删除{deleteTarget?.isDirectory ? "文件夹" : "文件"}
            </DialogTitle>
            <DialogDescription>
              确定要删除 <span className="font-medium text-foreground">{deleteTarget?.name}</span> 吗？
              {deleteTarget?.isDirectory ? "文件夹内的所有内容都将被删除。" : ""}
              此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => { void handleDelete(); }}
              disabled={deleting}
            >
              {deleting ? "删除中..." : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
