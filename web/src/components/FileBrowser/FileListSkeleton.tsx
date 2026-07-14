import { cn } from "@/lib/utils";

interface FileListSkeletonProps {
  rows?: number;
  layout?: "list" | "grid";
}

/** 加载骨架屏：结构与 FileListItem / FileGridItem 对齐，避免闪烁。 */
export function FileListSkeleton({ rows = 8, layout = "list" }: FileListSkeletonProps) {
  if (layout === "grid") {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2 p-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col items-center gap-2 rounded-xl p-3"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <div className={cn("size-16 rounded-2xl bg-muted", "animate-pulse")} />
            <div className="w-full space-y-1.5">
              <div className="mx-auto h-2.5 w-3/4 rounded-full bg-muted animate-pulse" />
              <div className="mx-auto h-2 w-1/2 rounded-full bg-muted/60 animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1 p-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xl px-2.5 py-2"
          style={{ animationDelay: `${i * 40}ms` }}
        >
          <div className="size-9 shrink-0 rounded-lg bg-muted animate-pulse" />
          <div className="flex-1 space-y-1.5">
            <div
              className="h-3 rounded-full bg-muted animate-pulse"
              style={{ width: `${55 + ((i * 13) % 35)}%` }}
            />
            <div
              className="h-2 rounded-full bg-muted/60 animate-pulse"
              style={{ width: `${28 + ((i * 7) % 25)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
