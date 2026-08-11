import { useEffect, useRef, useState } from "react";
import { EntityIcons } from "@/lib/icons";
import { authFetch } from "@/lib/authFetch";
import {
  resolveBillingAllowance,
  type MyMemberBudget as MemberBudgetAllowance,
} from "@/hooks/useTenantBillingVisibility";
import {
  consumePendingBillingBadgeOpen,
  subscribeBillingBadgeOpen,
} from "@/lib/billingBadgeBus";

interface BillingSummary {
  balanceCredits: number;
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

interface MyMemberBudget extends MemberBudgetAllowance {
  monthUsedCredits: number;
  canStartRun: boolean;
  usageRatioBps: number | null;
  status: MemberBudgetStatus;
}

interface BillingMiniBadgeProps {
  isAdmin: boolean;
  sessionId?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  if (Math.abs(value) >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDetailedCredits(value: number): string {
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

/** 预算进度条填充色：与 budgetStatusClass 同一套状态语义，避免文字与进度条讲两种话。 */
function budgetBarClass(status: MemberBudgetStatus): string {
  if (status === "over") return "bg-rose-500";
  if (status === "warning") return "bg-amber-500";
  if (status === "attention") return "bg-orange-400";
  if (status === "normal") return "bg-emerald-500";
  return "bg-muted-foreground/30";
}

function budgetBarWidth(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value / 100));
}

/**
 * 触发按钮的告警等级：余额不足或已超个人预算=danger，临近预算=warn，其余保持无色。
 * 颜色只承载状态，不做常态装饰——常态下按钮与右上角其他 ghost 控件同重量。
 */
function badgeTone(lowBalance: boolean, status: MemberBudgetStatus | undefined, blocked = false): "none" | "warn" | "danger" {
  if (lowBalance || blocked || status === "over") return "danger";
  if (status === "warning") return "warn";
  return "none";
}

const BADGE_TONE_CLASS: Record<"none" | "warn" | "danger", string> = {
  none: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  warn: "border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/50",
  danger: "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200 dark:hover:bg-rose-950/50",
};

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  );
}

export function BillingMiniBadge({
  isAdmin,
  sessionId,
  open: controlledOpen,
  onOpenChange,
}: BillingMiniBadgeProps) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionBillingSummary | null>(null);
  const [memberBudget, setMemberBudget] = useState<MyMemberBudget | null>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const handleOpenChange = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
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
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) handleOpenChange(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // 响应外部（侧边栏用户菜单「我的积分」入口）打开请求：挂载时消费 pending 标志，同时订阅后续请求。
  useEffect(() => {
    if (consumePendingBillingBadgeOpen()) handleOpenChange(true);
    const unsub = subscribeBillingBadgeOpen(() => {
      if (consumePendingBillingBadgeOpen()) handleOpenChange(true);
    });
    return unsub;
  }, []);

  if (!summary || !summary.billingEnabled || summary.billingMode === "internal") return null;

  const tone = badgeTone(summary.lowBalance, memberBudget?.status, memberBudget?.canStartRun === false);
  const allowance = resolveBillingAllowance(summary, memberBudget);
  const allowanceLabel = allowance.source === "member" ? "个人剩余额度" : "组织可用积分";

  return (
    <div ref={containerRef} className="relative" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => handleOpenChange(!open)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium tabular-nums transition-colors ${BADGE_TONE_CLASS[tone]}`}
        title={allowanceLabel}
      >
        <EntityIcons.credits className="size-4" aria-hidden="true" />
        {formatCredits(allowance.credits)}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-1.5rem)] rounded-[20px] border bg-popover p-2 text-popover-foreground shadow-[0_18px_50px_rgba(15,23,42,0.16)]">
          <div className="rounded-2xl border border-border/80 bg-muted/35 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <EntityIcons.credits className="size-[18px]" aria-hidden="true" />
                {allowanceLabel}
              </span>
              <span className="rounded-full bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                {billingModeLabel(summary.billingMode)}
              </span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-2xl font-semibold leading-none tabular-nums">
                {formatDetailedCredits(allowance.credits)}
              </span>
              <span className="text-xs text-muted-foreground">{allowance.source === "member" ? "本月可用" : "可用"}</span>
              {summary.lowBalance && (
                <span className="ml-auto rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                  余额较低
                </span>
              )}
            </div>
          </div>

          <div className="px-3 pb-3 pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium">我的本月</span>
              {memberBudget && (
                <span className={`text-[11px] font-medium tabular-nums ${budgetStatusClass(memberBudget.status)}`}>
                  {memberBudget.canStartRun ? `${formatUsageRatio(memberBudget.usageRatioBps)} · ${budgetStatusLabel(memberBudget.status)}` : "后续动作已停止"}
                </span>
              )}
            </div>
            {memberBudget ? (
              <>
                {memberBudget.monthlyLimitCredits !== null && (
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-[width] ${budgetBarClass(memberBudget.status)}`}
                      style={{ width: `${budgetBarWidth(memberBudget.usageRatioBps)}%` }}
                    />
                  </div>
                )}
                <div className="mt-2.5 space-y-1.5 text-[13px]">
                  <StatRow label="已结算用量" value={formatDetailedCredits(memberBudget.monthUsedCredits)} />
                  <StatRow
                    label="我的月度额度"
                    value={memberBudget.monthlyLimitCredits === null ? "未设置" : formatDetailedCredits(memberBudget.monthlyLimitCredits)}
                  />
                </div>
              </>
            ) : (
              <div className="mt-2 text-[13px] text-muted-foreground">个人预算数据暂不可用</div>
            )}
          </div>

          {isAdmin && (
            <div className="border-t border-border/60 px-3 py-3">
              <div className="text-[13px] font-medium">公司共享积分池</div>
              <div className="mt-2.5 space-y-1.5 text-[13px]">
                <StatRow label="总余额" value={formatDetailedCredits(summary.balanceCredits)} />
                <StatRow label="组织本月消耗" value={formatDetailedCredits(summary.currentMonthCreditsUsed)} />
              </div>
            </div>
          )}

          {sessionSummary && (
            <div className="border-t border-border/60 px-3 py-3 text-[13px]">
              <StatRow
                label={`当前会话${sessionSummary.childSessionCount ? `（含 ${sessionSummary.childSessionCount} 个子 Agent）` : ""}`}
                value={formatDetailedCredits(sessionSummary.creditsUsed)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
