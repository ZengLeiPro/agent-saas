import { useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { formatFileSize, formatShortDate } from "@agent/shared";
import type { FileEntry } from "@agent/shared";
import { cn } from "@/lib/utils";
import { FileIconTile } from "./fileIcons";

interface FileListItemProps {
  entry: FileEntry;
  onClick: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  showPath?: boolean;
}

/** 从 "assets/20260321/xx/file.md" 提取中间目录 "20260321/xx" 用于「所有文件」视图展示相对路径 */
function getParentFolder(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(1, -1).join("/") : "";
}

export function FileListItem({ entry, onClick, onDelete, showPath }: FileListItemProps) {
  const [hover, setHover] = useState(false);
  const parentFolder = showPath ? getParentFolder(entry.path) : "";

  return (
    <div
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
        "hover:bg-accent/60",
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none"
        onClick={() => onClick(entry)}
      >
        <FileIconTile entry={entry} size="sm" open={entry.isDirectory && hover} />

        <span className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-5 text-foreground">
            {entry.name}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] leading-4 text-muted-foreground">
            {showPath && parentFolder ? (
              <>
                <span className="truncate text-muted-foreground/80">{parentFolder}/</span>
                <span className="text-muted-foreground/40">·</span>
              </>
            ) : null}
            {!entry.isDirectory && (
              <>
                <span>{formatFileSize(entry.size)}</span>
                <span className="text-muted-foreground/40">·</span>
              </>
            )}
            <span className="truncate">{formatShortDate(entry.modifiedAt)}</span>
          </div>
        </span>

        {entry.isDirectory && (
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground/40 transition-transform",
              "group-hover:translate-x-0.5 group-hover:text-muted-foreground",
            )}
          />
        )}
      </button>

      {onDelete && (
        <button
          type="button"
          className={cn(
            "shrink-0 rounded-md p-1.5 text-muted-foreground/60 transition-all",
            "opacity-0 -mr-1 group-hover:opacity-100 group-hover:mr-0",
            "hover:bg-destructive/10 hover:text-destructive focus:opacity-100 focus:outline-none",
          )}
          onClick={(e) => { e.stopPropagation(); onDelete(entry); }}
          title="删除"
          aria-label={`删除 ${entry.name}`}
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}
