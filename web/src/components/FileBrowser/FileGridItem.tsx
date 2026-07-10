import { useState } from "react";
import { Trash2 } from "lucide-react";
import { formatFileSize, formatShortDate } from "@agent/shared";
import type { FileEntry } from "@agent/shared";
import { cn } from "@/lib/utils";
import { FileIconTile } from "./fileIcons";

interface FileGridItemProps {
  entry: FileEntry;
  onClick: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
}

/** 网格视图：大图标 + 文件名，参考 macOS Finder / Figma 项目卡片 */
export function FileGridItem({ entry, onClick, onDelete }: FileGridItemProps) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className={cn(
        "group relative flex flex-col items-center gap-2 rounded-xl p-3 transition-colors",
        "hover:bg-accent/60",
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className="flex w-full min-w-0 flex-col items-center gap-2 text-center focus:outline-none"
        onClick={() => onClick(entry)}
        title={entry.name}
      >
        <FileIconTile entry={entry} size="lg" open={entry.isDirectory && hover} />
        <div className="min-w-0 w-full">
          <div className="line-clamp-2 break-all text-[12px] font-medium leading-4 text-foreground">
            {entry.name}
          </div>
          <div className="mt-1 truncate text-[10px] leading-3 text-muted-foreground/80">
            {entry.isDirectory ? formatShortDate(entry.modifiedAt) : formatFileSize(entry.size)}
          </div>
        </div>
      </button>

      {onDelete && (
        <button
          type="button"
          className={cn(
            "absolute right-1.5 top-1.5 rounded-md p-1.5 text-muted-foreground/60 transition-all",
            "opacity-0 group-hover:opacity-100 focus:opacity-100",
            "bg-background/80 backdrop-blur-sm shadow-sm ring-1 ring-border/50",
            "hover:bg-destructive/10 hover:text-destructive focus:outline-none",
          )}
          onClick={(e) => { e.stopPropagation(); onDelete(entry); }}
          title="删除"
          aria-label={`删除 ${entry.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
