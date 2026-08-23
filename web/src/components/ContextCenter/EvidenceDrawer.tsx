import { ExternalLink, FileSearch, Loader2, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import type { ContextEvidence, ContextSource, EvidenceFreshness } from "./types";

const FRESHNESS_LABEL: Record<EvidenceFreshness, string> = {
  fresh: "新鲜",
  aging: "临近过期",
  stale: "已过期",
  unknown: "未评估",
};

const FRESHNESS_VARIANT = {
  fresh: "success",
  aging: "warning",
  stale: "danger",
  unknown: "muted",
} as const satisfies Record<EvidenceFreshness, "success" | "warning" | "danger" | "muted">;

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

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function EvidenceItem({ item }: { item: ContextEvidence }) {
  const originalUrl = safeExternalUrl(item.originalUrl);
  return (
    <article className="rounded-xl border bg-card p-4" data-testid="evidence-item">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{item.sourceName}</Badge>
        <span className="text-xs text-muted-foreground">Collection：{item.collection}</span>
        <Badge variant={item.derived ? "info" : "outline"}>{item.derived ? "派生证据" : "原始证据"}</Badge>
        <Badge variant={FRESHNESS_VARIANT[item.freshness]}>新鲜度：{FRESHNESS_LABEL[item.freshness]}</Badge>
      </div>

      <blockquote className="mt-3 whitespace-pre-wrap border-l-2 border-primary/40 pl-3 text-sm leading-6 text-foreground">
        “{item.quote}”
      </blockquote>

      <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">作者</dt>
          <dd className="mt-0.5">{item.author || "未提供"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">原文时间</dt>
          <dd className="mt-0.5 tabular-nums">{formatDateTime(item.occurredAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">新鲜度评估时间</dt>
          <dd className="mt-0.5 tabular-nums">{formatDateTime(item.freshnessAsOf)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">证据类型</dt>
          <dd className="mt-0.5">{item.derived ? "派生证据（经原始记录加工，建议回看原文）" : "原始证据（直接来自原记录）"}</dd>
        </div>
      </dl>

      {originalUrl ? (
        <a
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          href={originalUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          在原系统中打开
          <ExternalLink className="size-3.5" />
        </a>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">原系统链接未提供</p>
      )}
    </article>
  );
}

export interface EvidenceDrawerProps {
  source: ContextSource | null;
  items: ContextEvidence[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: (source: ContextSource) => void;
}

export function EvidenceDrawer({ source, items, loading, error, onClose, onRetry }: EvidenceDrawerProps) {
  return (
    <Sheet open={source !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Evidence</SheetTitle>
          <SheetDescription>
            {source ? `${source.name} · ${source.collection}` : "查看上下文证据与原始出处"}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在加载证据
            </div>
          )}

          {!loading && error && source && (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-danger/30 bg-danger/5 p-6 text-center">
              <p className="text-sm text-danger-ink">{error}</p>
              <Button variant="outline" size="sm" onClick={() => onRetry(source)}>
                <RefreshCw className="mr-1.5 size-3.5" />重试
              </Button>
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center">
              <FileSearch className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">暂无可展示证据</p>
              <p className="text-xs text-muted-foreground">该 Collection 尚未返回证据片段。</p>
            </div>
          )}

          {!loading && !error && items.length > 0 && (
            <div className="space-y-3">
              {items.map((item) => <EvidenceItem key={item.id} item={item} />)}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
