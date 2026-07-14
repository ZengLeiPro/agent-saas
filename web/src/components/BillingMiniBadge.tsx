import { useEffect, useRef, useState } from "react";
import { EntityIcons } from "@/lib/icons";
import { authFetch } from "@/lib/authFetch";
import { Separator } from "@/components/ui/separator";
import {
  consumePendingBillingBadgeOpen,
  subscribeBillingBadgeOpen,
} from "@/lib/billingBadgeBus";

interface BillingSummary {
  balanceCredits: number;
  reservedCredits: number;
  lowBalance: boolean;
  billingEnabled: boolean;
  billingMode: string;
  currentMonthCreditsUsed: number;
  currentMonthRevenueYuan: number;
}

interface SessionBillingSummary {
  sessionId: string;
  creditsUsed: number;
  revenueYuan: number;
  childSessionCount?: number;
}

interface BillingMiniBadgeProps {
  sessionId?: string | null;
}

function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  if (Math.abs(value) >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatSessionCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function billingModeLabel(mode: string): string {
  switch (mode) {
    case "prepaid":
      return "预付费";
    case "postpaid":
      return "后付费";
    case "trial":
      return "试用";
    case "internal":
      return "内部";
    default:
      return mode || "未配置";
  }
}

export function BillingMiniBadge({ sessionId }: BillingMiniBadgeProps) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionBillingSummary | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [accountRes, sessionRes] = await Promise.all([
          authFetch("/api/billing/me/summary"),
          sessionId
            ? authFetch(`/api/billing/sessions/${encodeURIComponent(sessionId)}/summary`).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!accountRes.ok) throw new Error(`billing summary ${accountRes.status}`);
        const accountJson = await accountRes.json() as { summary: BillingSummary };
        const nextSession = sessionRes?.ok
          ? ((await sessionRes.json()) as { summary: SessionBillingSummary }).summary
          : null;
        if (!cancelled) {
          setSummary(accountJson.summary);
          setSessionSummary(nextSession);
        }
      } catch {
        if (!cancelled) {
          setSummary(null);
          setSessionSummary(null);
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // 响应外部（侧边栏用户菜单「我的积分」入口）打开请求：挂载时消费 pending 标志，同时订阅后续请求。
  useEffect(() => {
    if (consumePendingBillingBadgeOpen()) setOpen(true);
    const unsub = subscribeBillingBadgeOpen(() => {
      if (consumePendingBillingBadgeOpen()) setOpen(true);
    });
    return unsub;
  }, []);

  if (!summary || !summary.billingEnabled || summary.billingMode === "internal") return null;

  return (
    <div ref={containerRef} className="relative" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-2.5 text-xs font-semibold text-brand-700 shadow-sm tabular-nums transition-colors hover:border-brand-300 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-900/35 dark:text-brand-100 dark:hover:bg-brand-900/55"
        title="组织积分余额"
      >
        <EntityIcons.credits className="h-3.5 w-3.5" aria-hidden="true" />
        {formatCredits(summary.balanceCredits)}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl">
          <div className="px-4 pb-3 pt-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <EntityIcons.credits className="h-4 w-4 text-brand-600 dark:text-brand-300" aria-hidden="true" />
                积分余额
              </div>
              <div className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                {billingModeLabel(summary.billingMode)}
              </div>
            </div>
            <div className="mt-3 text-right text-2xl font-semibold leading-none tabular-nums">
              {formatCredits(summary.balanceCredits)}
            </div>
            {summary.lowBalance && (
              <div className="mt-2 text-right text-[11px] text-destructive">余额较低</div>
            )}
          </div>

          <Separator />

          <div className="space-y-2 px-4 py-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">可用余额</span>
              <span className="font-mono tabular-nums">{formatCredits(summary.balanceCredits)}</span>
            </div>
            {summary.reservedCredits > 0 && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">已预留</span>
                <span className="font-mono tabular-nums">{formatCredits(summary.reservedCredits)}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">本月消耗</span>
              <span className="font-mono tabular-nums">{formatCredits(summary.currentMonthCreditsUsed)}</span>
            </div>
            {sessionSummary && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  当前会话{sessionSummary.childSessionCount ? `（含 ${sessionSummary.childSessionCount} 个子 Agent）` : ''}
                </span>
                <span className="font-mono tabular-nums">{formatSessionCredits(sessionSummary.creditsUsed)}</span>
              </div>
            )}
          </div>

          <div className="border-t bg-muted/35 px-4 py-2 text-[10px] leading-relaxed text-muted-foreground">
            积分用于 Agent 服务，实际消耗以平台计费记录为准。
          </div>
        </div>
      )}
    </div>
  );
}
