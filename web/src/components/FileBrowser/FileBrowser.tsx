import { useState, useCallback, useMemo, type ReactNode } from "react";
import {
  RefreshCw, X, FolderTree, List, ArrowUpDown, ArrowUp, ArrowDown,
  LayoutGrid, Rows3, FolderX,
} from "lucide-react";
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
import { FileGridItem } from "./FileGridItem";
import { FileListSkeleton } from "./FileListSkeleton";
import { EmptyState } from "./EmptyState";
import { useFileList } from "./useFileList";

export interface FileBrowserProps {
  onClose?: () => void;
  onPreviewFile: (path: string, owner?: string) => void;
  owner?: string;
  fullPage?: boolean;
  reserveCloseButtonSpace?: boolean;
}

type ViewMode = "folder" | "all";
type LayoutMode = "list" | "grid";

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
const LAYOUT_STORAGE_KEY = "files.layout";

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

function loadLayoutMode(): LayoutMode {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw === "grid" || raw === "list") return raw;
  } catch { /* ignore */ }
  return "list";
}

/** 分段控件容器：视图模式和布局模式共享一致的圆角胶囊样式 */
function SegmentedGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center rounded-lg bg-muted/60 p-0.5 ring-1 ring-inset ring-border/40">
      {children}
    </div>
  );
}

function SegmentedButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex size-6 items-center justify-center rounded-md transition-all",
        active
          ? "bg-card text-foreground shadow-sm ring-1 ring-inset ring-border/60"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

export function FileBrowser({ onClose, onPreviewFile, owner, fullPage, reserveCloseButtonSpace }: FileBrowserProps) {
  const { user: authUser } = useAuth();
  // 历史 admin OwnerPicker 已移除（任何角色都不允许查看他人文件目录，
  // 后端 /api/file/* 已收紧到 isPlatformAdmin + 同组织校验）。
  const effectiveOwner = owner ?? authUser?.username;

  const [currentPath, setCurrentPath] = useState("assets");
  const [viewMode, setViewMode] = useState<ViewMode>("folder");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(loadLayoutMode);
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

  const updateLayoutMode = useCallback((mode: LayoutMode) => {
    setLayoutMode(mode);
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, mode); } catch { /* ignore */ }
  }, []);

  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const listPath = viewMode === "all" ? "assets" : currentPath;
  const { entries: rawEntries, loading, error, refresh } = useFileList(listPath, effectiveOwner, viewMode === "all");

  const entries = useMemo(
    () => sortEntries(rawEntries, sortKey, sortOrder),
    [rawEntries, sortKey, sortOrder],
  );

  const stats = useMemo(() => {
    let folders = 0;
    let files = 0;
    let totalSize = 0;
    for (const e of rawEntries) {
      if (e.isDirectory) folders += 1;
      else { files += 1; totalSize += e.size; }
    }
    return { folders, files, totalSize };
  }, [rawEntries]);

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
      {/* Header：面包屑 + 视图切换 + 刷新 */}
      <div
        className={cn(
          "flex h-12 shrink-0 items-center gap-1.5 border-b border-border/60 px-3",
          reserveCloseButtonSpace && "pr-10",
        )}
      >
        <div className="min-w-0 flex-1">
          {viewMode === "folder" ? (
            <Breadcrumb currentPath={currentPath} onNavigate={setCurrentPath} />
          ) : (
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
              <List className="size-3.5" />
              所有文件
            </div>
          )}
        </div>

        {/* 视图模式：文件夹 / 所有文件 */}
        <SegmentedGroup>
          <SegmentedButton
            active={viewMode === "folder"}
            onClick={() => setViewMode("folder")}
            title="文件夹视图"
          >
            <FolderTree className="size-3.5" />
          </SegmentedButton>
          <SegmentedButton
            active={viewMode === "all"}
            onClick={() => setViewMode("all")}
            title="所有文件"
          >
            <List className="size-3.5" />
          </SegmentedButton>
        </SegmentedGroup>

        {/* 布局模式：列表 / 网格 */}
        <SegmentedGroup>
          <SegmentedButton
            active={layoutMode === "list"}
            onClick={() => updateLayoutMode("list")}
            title="列表布局"
          >
            <Rows3 className="size-3.5" />
          </SegmentedButton>
          <SegmentedButton
            active={layoutMode === "grid"}
            onClick={() => updateLayoutMode("grid")}
            title="网格布局"
          >
            <LayoutGrid className="size-3.5" />
          </SegmentedButton>
        </SegmentedGroup>

        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={refresh}
          title="刷新"
          disabled={loading}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>

        {!fullPage && onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            title="关闭"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      {/* 排序栏：chip 风格 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-1.5">
        <ArrowUpDown className="mr-0.5 size-3 text-muted-foreground/50" />
        {SORT_KEYS.map((key) => {
          const active = sortKey === key;
          return (
            <button
              key={key}
              type="button"
              className={cn(
                "flex items-center gap-0.5 rounded-md px-2 py-1 text-[11px] leading-none transition-all",
                active
                  ? "bg-brand-50 font-medium text-brand-700 ring-1 ring-inset ring-brand-200/60 dark:bg-brand-900/40 dark:text-brand-200 dark:ring-brand-700/40"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              onClick={() => handleSortClick(key)}
              aria-pressed={active}
            >
              {FILE_SORT_LABELS[key]}
              {active && (
                sortOrder === "asc"
                  ? <ArrowUp className="size-3" />
                  : <ArrowDown className="size-3" />
              )}
            </button>
          );
        })}
      </div>

      {/* 主体内容区 */}
      {loading ? (
        <ScrollArea className="flex-1">
          <FileListSkeleton layout={layoutMode} />
        </ScrollArea>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/20">
            <FolderX className="size-7" strokeWidth={1.5} />
          </div>
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-foreground">加载失败</p>
            <p className="text-xs text-muted-foreground">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-3.5" />
            重试
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState variant={viewMode} />
      ) : (
        <ScrollArea className="flex-1">
          {layoutMode === "list" ? (
            <div className="space-y-0.5 p-2">
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
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1 p-2">
              {entries.map((entry) => (
                <FileGridItem
                  key={entry.path}
                  entry={entry}
                  onClick={handleEntryClick}
                  onDelete={setDeleteTarget}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      )}

      {/* 底部统计栏：只有内容时展示，帮助扫读整体规模 */}
      {!loading && !error && entries.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>
            {stats.folders > 0 && `${stats.folders} 个文件夹`}
            {stats.folders > 0 && stats.files > 0 && " · "}
            {stats.files > 0 && `${stats.files} 个文件`}
          </span>
          {stats.files > 0 && (
            <span className="tabular-nums text-muted-foreground/70">
              {formatBytesCompact(stats.totalSize)}
            </span>
          )}
        </div>
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

/** 底部合计使用极简单位显示：与 shared 的 formatFileSize 拉齐，但输出更短。 */
function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(val >= 100 ? 0 : 1)} ${units[i]}`;
}
