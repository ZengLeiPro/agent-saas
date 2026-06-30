import { Folder, FileText, FileImage, FileCode, File, ChevronRight, Trash2 } from "lucide-react";
import { formatFileSize, formatShortDate } from "@agent/shared";
import type { FileEntry } from "@agent/shared";

interface FileListItemProps {
  entry: FileEntry;
  onClick: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  showPath?: boolean;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"]);
const CODE_EXTS = new Set([".json", ".js", ".ts", ".jsx", ".tsx", ".css", ".py", ".sh"]);
const TEXT_EXTS = new Set([".md", ".txt", ".html", ".htm", ".csv", ".xml", ".log"]);

function getFileIcon(entry: FileEntry) {
  if (entry.isDirectory) return <Folder className="h-5 w-5 text-link" />;
  if (TEXT_EXTS.has(entry.extension)) return <FileText className="h-5 w-5 text-muted-foreground" />;
  if (IMAGE_EXTS.has(entry.extension)) return <FileImage className="h-5 w-5 text-success" />;
  if (CODE_EXTS.has(entry.extension)) return <FileCode className="h-5 w-5 text-warning" />;
  return <File className="h-5 w-5 text-muted-foreground" />;
}

/** 从 "assets/20260321/file.md" 提取 "20260321" */
function getParentFolder(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(1, -1).join("/") : "";
}

export function FileListItem({ entry, onClick, onDelete, showPath }: FileListItemProps) {
  const parentFolder = showPath ? getParentFolder(entry.path) : "";

  return (
    <div className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={() => onClick(entry)}
      >
        <span className="shrink-0">{getFileIcon(entry)}</span>
        <span className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{entry.name}</div>
          {showPath && parentFolder && (
            <div className="truncate text-xs text-muted-foreground/60">{parentFolder}/</div>
          )}
        </span>
        {entry.isDirectory ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
        ) : (
          <span className="shrink-0 text-right text-xs text-muted-foreground">
            <div>{formatShortDate(entry.modifiedAt)}</div>
            <div className="text-muted-foreground/60">{formatFileSize(entry.size)}</div>
          </span>
        )}
      </button>
      {onDelete && (
        <button
          type="button"
          className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/10 group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onDelete(entry); }}
          title="删除"
        >
          <Trash2 className="h-4 w-4 text-destructive/70" />
        </button>
      )}
    </div>
  );
}
