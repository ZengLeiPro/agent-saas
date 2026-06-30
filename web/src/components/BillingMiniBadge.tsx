import { useEffect, useRef, useState } from "react";
import { Coins } from "lucide-react";
import { authFetch } from "@/lib/authFetch";

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

  if (!summary || !summary.billingEnabled || summary.billingMode === "internal") return null;

  const color = summary.lowBalance
    ? "text-amber-600 dark:text-amber-400"
    : "text-muted-foreground";

  return (
    <div ref={containerRef} className="relative" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium tabular-nums transition-colors hover:bg-accent hover:text-accent-foreground ${color}`}
        title="组织积分余额"
      >
        <Coins className="h-3.5 w-3.5" />
        {formatCredits(summary.balanceCredits)}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border bg-popover p-3 text-xs shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-medium">积分余额</div>
            <div className="text-[10px] text-muted-foreground">{summary.billingMode}</div>
          </div>
          <div className="space-y-1.5">
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
                <span className="text-muted-foreground">当前会话</span>
                <span className="font-mono tabular-nums">{formatCredits(sessionSummary.creditsUsed)}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
