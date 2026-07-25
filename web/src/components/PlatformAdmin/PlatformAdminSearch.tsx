import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { navigateToHref } from "@/lib/urlSync";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "./api";
import { formatEntityKind, formatRole, formatRunStatus } from "./displayText";
import type { PlatformSearchMatch, SearchMatchKind } from "./types";

const KIND_LABEL: Record<SearchMatchKind, string> = {
  run: formatEntityKind("run"),
  session: formatEntityKind("session"),
  user: formatEntityKind("user"),
  tenant: formatEntityKind("tenant"),
  sandbox: formatEntityKind("sandbox"),
  workspace: formatEntityKind("workspace"),
};

function resultTitle(match: PlatformSearchMatch): string {
  if (match.kind === "run") return `执行记录 ${match.id}`;
  return match.title;
}

function resultSubtitle(match: PlatformSearchMatch): string | undefined {
  if (!match.subtitle) return undefined;
  return match.subtitle
    .split(" · ")
    .map((part) => {
      if (["pending", "running", "waiting_approval", "waiting_user", "waiting_hand", "completed", "failed", "cancelled", "orphaned"].includes(part)) {
        return formatRunStatus(part);
      }
      if (part === "deleted") return "已删除";
      if (part === "disabled") return "已禁用";
      if (part === "admin" || part === "user") return formatRole(part);
      return part;
    })
    .join(" · ");
}

export function PlatformAdminSearch({ className }: { className?: string } = {}) {
  const adminQuery = useAdminUrlQuery();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [q, setQ] = useState(adminQuery.get("lookup") ?? "");
  const [matches, setMatches] = useState<PlatformSearchMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 键盘高亮项下标。-1 = 无高亮，此时 Enter 走「重新搜索」而不是「打开某条结果」。
   *
   * 这是本站唯一的全局快捷键（`/`）入口，若只能用 `/` 聚焦却必须切回鼠标点结果，
   * 键盘动线是断的。
   */
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const runSearch = useCallback(async (value = q.trim()) => {
    if (!value) return;
    setLoading(true);
    setError(null);
    adminQuery.set("lookup", value);
    try {
      const data = await platformAdminApi.search(value);
      if (data.matches.length === 1 && data.matches[0].id === value) {
        navigateToHref(data.matches[0].href);
        setOpen(false);
      } else {
        setMatches(data.matches);
        setOpen(true);
        setActiveIndex(-1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMatches([]);
      setOpen(true);
      setActiveIndex(-1);
    } finally {
      setLoading(false);
    }
  }, [adminQuery, q]);

  const openMatch = useCallback((match: PlatformSearchMatch) => {
    navigateToHref(match.href);
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  /** 高亮项滚进可视区——结果最多 80px 高的滚动容器，第 5 条之后不滚就看不见 */
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.querySelectorAll<HTMLElement>("[data-search-result]")[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // 结果没展开时，方向键不该劫持光标移动
      if (!open || matches.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((prev) => {
        const next = prev + step;
        // 两端循环：到底回顶、到顶回底，长列表里比撞墙好用
        if (next < 0) return matches.length - 1;
        if (next >= matches.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === "Enter") {
      const active = activeIndex >= 0 ? matches[activeIndex] : undefined;
      if (active) {
        event.preventDefault();
        openMatch(active);
        return;
      }
      void runSearch();
    }
  }, [activeIndex, matches, open, openMatch, runSearch]);

  return (
    <div className={cn("relative w-full max-w-xl", className)}>
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              // 词变了，旧的高亮不再对应任何结果
              setActiveIndex(-1);
            }}
            onFocus={() => {
              if (matches.length > 0 || error) setOpen(true);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="搜索组织、用户、对话或完整记录 ID"
            className="h-9 pl-7 pr-16 text-xs"
            role="combobox"
            aria-expanded={open}
            aria-controls="platform-admin-search-results"
            aria-activedescendant={activeIndex >= 0 ? `platform-admin-search-result-${activeIndex}` : undefined}
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-2xs text-muted-foreground">/</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => void runSearch()} disabled={loading || !q.trim()}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
        </Button>
      </div>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-full overflow-hidden rounded-lg border bg-popover shadow-lg">
          {error ? (
            <div className="px-3 py-2 text-sm text-destructive">{error}</div>
          ) : matches.length === 0 ? (
            <div className="px-3 py-5 text-center text-sm text-muted-foreground">
              <div>没有匹配结果</div>
              <div className="mt-1 text-xs">支持搜索：组织名、用户名、姓名、手机号、对话标题或完整记录 ID</div>
            </div>
          ) : (
            <div className="max-h-80 overflow-auto py-1" ref={listRef} id="platform-admin-search-results" role="listbox">
              {matches.map((match, index) => (
                <button
                  key={`${match.kind}:${match.id}:${match.href}`}
                  id={`platform-admin-search-result-${index}`}
                  data-search-result
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  tabIndex={-1}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/60",
                    index === activeIndex && "bg-muted/60",
                  )}
                  // 鼠标移到哪就把键盘高亮同步到哪，避免两套高亮同时亮着
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => openMatch(match)}
                >
                  <Badge variant="secondary" className="mt-0.5 shrink-0">{KIND_LABEL[match.kind]}</Badge>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{resultTitle(match)}</span>
                    {match.subtitle && <span className="block truncate text-xs text-muted-foreground">{resultSubtitle(match)}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
