import { useEffect, useState } from "react";
import { FileSearch, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import type { ContextCenterApiPort, ContextEvidence, ContextEvidenceRef } from "./types";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function errorMessage(_error: unknown): string {
  return "Evidence 授权详情加载失败，请重试";
}

function safeOriginalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function EvidenceReferenceDrawer({
  api,
  title,
  items,
  onClose,
}: {
  api: ContextCenterApiPort;
  title: string | null;
  items: ContextEvidenceRef[];
  onClose: () => void;
}) {
  const [details, setDetails] = useState<ContextEvidence[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (title === null || items.length === 0) {
      setDetails([]);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setDetails([]);
    setLoading(true);
    setError(null);
    void Promise.all(items.map(item => api.getEvidence(item.id, { signal: controller.signal })))
      .then(results => setDetails(results.flat()))
      .catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, items, retryKey, title]);

  return (
    <Sheet open={title !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Evidence</SheetTitle>
          <SheetDescription>{title || "证据引用"}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {loading ? (
            <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />正在拉取授权 Evidence 详情
            </div>
          ) : error ? (
            <div role="alert" className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-danger/30 bg-danger/5 p-6 text-center">
              <TriangleAlert className="size-7 text-danger-ink" />
              <p className="text-sm text-danger-ink">{error}</p>
              <Button variant="outline" size="sm" onClick={() => setRetryKey(value => value + 1)}>
                <RefreshCw className="mr-1.5 size-3.5" />重试
              </Button>
            </div>
          ) : details.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              <FileSearch className="mx-auto mb-2 size-7" />暂无可展示 Evidence 详情
            </div>
          ) : details.map((item, index) => {
            const originalUrl = safeOriginalUrl(item.originalUrl);
            return (
              <article key={`${item.id}:${index}`} className="rounded-xl border bg-card p-4" data-testid="evidence-detail">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.derived ? "derived" : "source"}</Badge>
                  <strong className="text-sm">{item.sourceName}</strong>
                </div>
                <blockquote className="mt-3 whitespace-pre-wrap border-l-2 pl-3 text-sm">{item.quote}</blockquote>
                <dl className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]">
                  <dt>来源</dt><dd>{item.sourceName} · {item.collection}{item.author ? ` · ${item.author}` : ""}</dd>
                  <dt>发生时间</dt><dd>{formatDateTime(item.occurredAt)}</dd>
                  <dt>新鲜度</dt><dd>{item.freshness} · 截至 {formatDateTime(item.freshnessAsOf)}</dd>
                  <dt>原始链接</dt><dd>{originalUrl ? <a className="break-all text-primary underline" href={originalUrl} target="_blank" rel="noreferrer">{originalUrl}</a> : "未提供"}</dd>
                </dl>
              </article>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
