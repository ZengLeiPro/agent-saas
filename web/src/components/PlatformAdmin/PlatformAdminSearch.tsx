import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "./api";
import { formatEntityKind } from "./displayText";
import type { PlatformSearchMatch, SearchMatchKind } from "./types";

const KIND_LABEL: Record<SearchMatchKind, string> = {
  run: formatEntityKind("run"),
  session: formatEntityKind("session"),
  user: formatEntityKind("user"),
  tenant: formatEntityKind("tenant"),
  sandbox: formatEntityKind("sandbox"),
  workspace: formatEntityKind("workspace"),
};

function navigateTo(href: string) {
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function PlatformAdminSearch({ className }: { className?: string } = {}) {
  const adminQuery = useAdminUrlQuery();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState(adminQuery.get("q") ?? "");
  const [matches, setMatches] = useState<PlatformSearchMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    adminQuery.set("q", value);
    try {
      const data = await platformAdminApi.search(value);
      if (data.matches.length === 1) {
        navigateTo(data.matches[0].href);
        setOpen(false);
      } else {
        setMatches(data.matches);
        setOpen(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMatches([]);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }, [adminQuery, q]);

  return (
    <div className={cn("relative w-full max-w-xl", className)}>
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onFocus={() => {
              if (matches.length > 0 || error) setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch();
              if (event.key === "Escape") setOpen(false);
            }}
            placeholder="搜索运行 / 会话 / 用户 / 租户 / 执行环境"
            className="h-9 pl-7 pr-16 text-xs"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">/</span>
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
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">没有匹配结果</div>
          ) : (
            <div className="max-h-80 overflow-auto py-1">
              {matches.map(match => (
                <button
                  key={`${match.kind}:${match.id}:${match.href}`}
                  type="button"
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/60"
                  onClick={() => {
                    navigateTo(match.href);
                    setOpen(false);
                  }}
                >
                  <Badge variant="secondary" className="mt-0.5 shrink-0">{KIND_LABEL[match.kind]}</Badge>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{match.title}</span>
                    {match.subtitle && <span className="block truncate text-xs text-muted-foreground">{match.subtitle}</span>}
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
