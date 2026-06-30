import { Loader2 } from "lucide-react";
import type { SessionSearchHit } from "@/lib/searchApi";
import { formatShortDate, sourceDisplayText } from "@/types/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SessionSearchResultsProps {
  hits: SessionSearchHit[];
  activeSessionId: string | null;
  isSearching: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  onSelect: (sessionId: string) => void;
  onLoadMore: () => void;
}

function highlightSnippet(snippet: string, ranges?: Array<{ start: number; end: number }>) {
  if (!ranges?.length) return snippet;
  const [range] = ranges;
  const start = Math.max(0, Math.min(snippet.length, range.start));
  const end = Math.max(start, Math.min(snippet.length, range.end));
  return (
    <>
      {snippet.slice(0, start)}
      <mark className="rounded bg-brand-accent-soft px-0.5 text-foreground">
        {snippet.slice(start, end)}
      </mark>
      {snippet.slice(end)}
    </>
  );
}

function firstSnippet(hit: SessionSearchHit) {
  return hit.matches[0]?.snippet || hit.preview || "";
}

export function SessionSearchResults({
  hits,
  activeSessionId,
  isSearching,
  isLoadingMore,
  hasMore,
  error,
  onSelect,
  onLoadMore,
}: SessionSearchResultsProps) {
  if (isSearching && hits.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        搜索中...
      </div>
    );
  }

  if (error && hits.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-destructive">
        搜索失败：{error}
      </div>
    );
  }

  if (hits.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
        没有找到相关会话
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {hits.map((hit) => {
        const match = hit.matches[0];
        const snippet = firstSnippet(hit);
        return (
          <button
            key={hit.sessionId}
            type="button"
            className={cn(
              "rounded-lg px-3 py-3 text-left transition-colors",
              hit.sessionId === activeSessionId
                ? "bg-brand-accent-soft"
                : "hover:bg-muted",
            )}
            onClick={() => onSelect(hit.sessionId)}
          >
            <div className="truncate text-sm font-medium leading-snug">
              {hit.title || "未命名会话"}
            </div>
            {snippet && (
              <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {highlightSnippet(snippet, match?.ranges)}
              </div>
            )}
            <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground/60">
              <span className="truncate">
                {hit.source ? sourceDisplayText(hit.source) : "会话"}
                {match?.kind ? ` · ${match.kind}` : ""}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatShortDate(hit.updatedAtMs)}
              </span>
            </div>
          </button>
        );
      })}
      {error && (
        <div className="px-3 py-2 text-xs text-destructive">
          加载更多失败：{error}
        </div>
      )}
      {hasMore && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mx-2 my-2"
          onClick={onLoadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              加载中...
            </>
          ) : (
            "加载更多搜索结果"
          )}
        </Button>
      )}
    </div>
  );
}
