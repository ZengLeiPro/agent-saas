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

type MemberBudgetStatus = "unset" | "normal" | "attention" | "warning" | "over";

interface MyMemberBudget {
  monthlyLimitCredits: number | null;
  monthUsedCredits: number;
  usageRatioBps: number | null;
  status: MemberBudgetStatus;
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

function formatUsageRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${(value / 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function budgetStatusLabel(status: MemberBudgetStatus): string {
  if (status === "over") return "已超预算";
  if (status === "warning") return "临近预算";
  if (status === "attention") return "需要关注";
  if (status === "normal") return "正常";
  return "未设置";
}

function budgetStatusClass(status: MemberBudgetStatus): string {
  if (status === "over") return "text-rose-600 dark:text-rose-300";
  if (status === "warning") return "text-amber-600 dark:text-amber-300";
  if (status === "attention") return "text-orange-600 dark:text-orange-300";
  if (status === "normal") return "text-emerald-600 dark:text-emerald-300";
  return "text-muted-foreground";
}

export function BillingMiniBadge({ sessionId }: BillingMiniBadgeProps) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionBillingSummary | null>(null);
  const [memberBudget, setMemberBudget] = useState<MyMemberBudget | null>(null);
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

  // 个人预算是增强信息，独立加载；接口失败或变慢都不能影响原有余额徽标。
  useEffect(() => {
    let cancelled = false;
    const loadBudget = async () => {
      try {
        const response = await authFetch("/api/billing/me/budget");
        if (!response.ok) throw new Error(`member budget ${response.status}`);
        const data = await response.json() as { budget: MyMemberBudget };
        if (!cancelled) setMemberBudget(data.budget);
      } catch {
        if (!cancelled) setMemberBudget(null);
      }
    };
    void loadBudget();
    const timer = window.setInterval(() => void loadBudget(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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
        <EntityIcons.credits className="size-3.5" aria-hidden="true" />
        {formatCredits(summary.balanceCredits)}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl">
          <div className="px-4 pb-3 pt-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <EntityIcons.credits className="size-4 text-brand-600 dark:text-brand-300" aria-hidden="true" />
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
            <div className="text-[11px] font-medium text-foreground">我的本月</div>
            {memberBudget ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">我的本月用量</span>
                  <span className="font-mono tabular-nums">{formatCredits(memberBudget.monthUsedCredits)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">我的月度预算</span>
                  <span className="font-mono tabular-nums">
                    {memberBudget.monthlyLimitCredits === null ? "未设置" : formatCredits(memberBudget.monthlyLimitCredits)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">使用率</span>
                  <span className={`font-mono tabular-nums ${budgetStatusClass(memberBudget.status)}`}>
                    {formatUsageRatio(memberBudget.usageRatioBps)} · {budgetStatusLabel(memberBudget.status)}
                  </span>
                </div>
              </>
            ) : (
              <div className="text-muted-foreground">个人预算数据暂不可用</div>
            )}
          </div>

          <Separator />

          <div className="space-y-2 px-4 py-3 text-xs">
            <div className="text-[11px] font-medium text-foreground">公司共享积分池</div>
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
              <span className="text-muted-foreground">组织本月消耗</span>
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
            员工预算仅用于提醒，不转移共享余额、不形成个人钱包，也不会阻断任务。实际消耗以平台计费记录为准。
          </div>
        </div>
      )}
    </div>
  );
}
