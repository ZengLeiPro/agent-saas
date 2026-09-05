import { ExternalLink, FileSearch, Loader2, RefreshCw } from 'lucide-react';
import { formatContextCitationTime, safeContextCitationUrl } from '@agent/shared';
import type { ContextCitationDetail, ContextCitationEvidence } from '@agent/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

function EvidenceItem({ item }: { item: ContextCitationEvidence }) {
  const nativeUrl = safeContextCitationUrl(item.nativeUrl);
  return (
    <article className="rounded-xl border bg-card p-4" data-testid="context-citation-evidence">
      <div className="text-xs text-muted-foreground">Evidence</div>
      <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-primary/40 pl-3 text-sm leading-6 text-foreground">
        “{item.quote}”
      </blockquote>
      <div className="mt-3 text-xs text-muted-foreground">
        作者：<span className="text-foreground">{item.author || '未提供'}</span>
      </div>
      {nativeUrl ? (
        <a
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          href={nativeUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          在原系统中打开
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      ) : item.nativeUrl ? (
        <p className="mt-3 text-xs text-muted-foreground">原文链接因安全策略不可打开</p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">原文链接未提供</p>
      )}
    </article>
  );
}

export interface ContextCitationDrawerProps {
  open: boolean;
  label: string;
  detail: ContextCitationDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}

export function ContextCitationDrawer({
  open,
  label,
  detail,
  loading,
  error,
  onClose,
  onRetry,
}: ContextCitationDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <SheetContent className="gap-0 sm:max-w-2xl" aria-label={`Context 引用：${label}`}>
        <SheetHeader>
          <SheetTitle>Context 引用</SheetTitle>
          <SheetDescription>{label}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              正在加载引用证据
            </div>
          ) : error ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-danger/30 bg-danger/5 p-6 text-center" role="alert">
              <p className="text-sm text-danger-ink">{error}</p>
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
                重试
              </Button>
            </div>
          ) : detail ? (
            <div className="space-y-4">
              <section className="rounded-xl border bg-muted/20 p-4">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">来源</dt>
                    <dd className="mt-1 font-medium">{detail.source}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">原文时间</dt>
                    <dd className="mt-1 tabular-nums">{formatContextCitationTime(detail.occurredAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Freshness</dt>
                    <dd className="mt-1">
                      <Badge variant="outline">{detail.freshness}</Badge>
                      {detail.freshnessAsOf ? (
                        <span className="ml-2 text-xs text-muted-foreground">截至 {formatContextCitationTime(detail.freshnessAsOf)}</span>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">证据状态</dt>
                    <dd className="mt-1 flex flex-wrap gap-2">
                      <Badge variant={detail.derived ? 'info' : 'outline'}>{detail.derived ? '派生证据' : '原始证据'}</Badge>
                      <Badge variant={detail.degraded ? 'warning' : 'outline'}>{detail.degraded ? '降级结果' : '未降级'}</Badge>
                    </dd>
                  </div>
                </dl>
              </section>

              {detail.evidence.length ? (
                <div className="space-y-3">
                  {detail.evidence.map((item, index) => (
                    <EvidenceItem key={`${index}-${item.quote}`} item={item} />
                  ))}
                </div>
              ) : (
                <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center">
                  <FileSearch className="size-8 text-muted-foreground" aria-hidden="true" />
                  <p className="text-sm font-medium">暂无可展示 Evidence</p>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
