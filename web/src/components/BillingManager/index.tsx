import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EntityIcons, ActionIcons } from "@/lib/icons";
import {
  CircleAlert,
  ArrowDownToLine,
  Search,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { authFetch } from "@/lib/authFetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useTenants } from "@/components/TenantManager/hooks";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

const CREDIT_MICRO = 1_000_000;
const YUAN_MICRO = 1_000_000;
const TAB_HASH_KEYS: Record<string, PlatformTab> = {
  overview: "overview",
  ledger: "ledger",
  "usage-events": "usage-events",
  "pricing-versions": "pricing-versions",
  audit: "audit",
};

type BillingMode = "prepaid" | "postpaid" | "trial" | "internal";
type HardCapMode = "none" | "stop_before_run";
type LedgerType =
  | "recharge" | "grant" | "refund" | "adjustment" | "expire" | "reversal"
  | "debit" | "reserve" | "release";
type PlatformTab = "overview" | "ledger" | "usage-events" | "pricing-versions" | "audit";

interface BillingSummary {
  tenantId: string;
  balanceCredits: number;
  reservedCredits: number;
  lowBalance: boolean;
  billingEnabled: boolean;
  billingMode: BillingMode;
  pricingVersion: string;
  policyVersion: string;
  creditValueYuan: number;
  currentMonthCreditsUsed: number;
  currentMonthRevenueYuan: number;
  currentMonthActualCostYuan?: number;
  currentMonthGrossMarginBps?: number;
}

interface BillingPolicy {
  tenantId: string;
  policyVersion: string;
  billingEnabled: boolean;
  pricingVersion: string;
  billingMode: BillingMode;
  defaultTargetMarginBps: number;
  organizationMultiplierBps: number;
  allowNegativeBalance: boolean;
  negativeLimitCreditsMicro: number;
  lowBalanceThresholdCreditsMicro: number;
  hardCapMode: HardCapMode;
  showBalance: boolean;
  showUsageCredits: boolean;
  showCost: boolean;
  showGrossMargin: boolean;
  updatedBy: string;
  updatedAt: string;
}

interface PricingVersion {
  version: string;
  name: string;
  status: "draft" | "active" | "retired";
  effectiveFrom: string;
  effectiveTo?: string;
  creditValueYuanMicro: number;
  defaultTargetMarginBps: number;
  fxRateToCny: number;
  currency: "CNY";
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt?: string;
}

interface LedgerEntry {
  id: string;
  type: LedgerType;
  source: string;
  creditsDeltaMicro: number;
  balanceBeforeMicro: number;
  balanceAfterMicro: number;
  revenueYuanMicro: number;
  actualCostYuanMicro: number;
  grossMarginBps?: number;
  sessionId?: string;
  runId?: string;
  note?: string;
  createdAt: string;
  createdBy?: string;
}

interface UsageEvent {
  id: string;
  tenantId: string;
  username: string;
  sessionId?: string;
  runId?: string;
  channel: string;
  billable: boolean;
  modelValue: string;
  actualModel?: string;
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  pricingVersion: string;
  fxRateToCny: number;
  actualCostYuanMicro: number;
  createdAt: string;
}

interface BillingAuditDailyPoint {
  date: string;
  actualCostYuanMicro: number;
  revenueYuanMicro: number;
  creditsChargedMicro: number;
  grossProfitYuanMicro: number;
}

interface BillingAuditSummary {
  days: number;
  actualCostYuanMicro: number;
  revenueYuanMicro: number;
  creditsChargedMicro: number;
  grossProfitYuanMicro: number;
  grossMarginBps: number | null;
  unpricedUsageEvents: number;
  lowBalanceTenants: Array<{ tenantId: string; balanceCreditsMicro: number; thresholdCreditsMicro: number }>;
  alerts: string[];
  daily?: BillingAuditDailyPoint[];
}

interface BillingState {
  summary: BillingSummary | null;
  policy: BillingPolicy | null;
  audit: BillingAuditSummary | null;
}

interface PolicyDraft {
  billingEnabled: boolean;
  billingMode: BillingMode;
  pricingVersion: string;
  targetMarginPct: string;
  multiplierPct: string;
  allowNegativeBalance: boolean;
  negativeLimitCredits: string;
  lowBalanceThresholdCredits: string;
  hardCapMode: HardCapMode;
  showBalance: boolean;
  showUsageCredits: boolean;
  showCost: boolean;
  showGrossMargin: boolean;
}

type Notice =
  | { kind: "success" | "info" | "error"; text: string; expiresAt: number }
  | null;

// ----- 工具函数 -----

function toCredits(micro: number): number {
  return micro / CREDIT_MICRO;
}

function creditsToMicro(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * CREDIT_MICRO) : 0;
}

function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(2)} 万`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatYuanMicro(value: number): string {
  return `¥${(value / YUAN_MICRO).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercentBps(value?: number | null): string {
  if (value === undefined || value === null) return "-";
  return `${(value / 100).toFixed(2)}%`;
}

function formatDateTime(value?: string): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function formatDate(value?: string): string {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function billingModeLabel(mode: BillingMode): string {
  if (mode === "internal") return "内部";
  if (mode === "postpaid") return "后付费";
  if (mode === "trial") return "试用";
  return "预付费";
}

function hardCapLabel(mode: HardCapMode): string {
  if (mode === "stop_before_run") return "余额不足拦截新任务";
  return "不封顶";
}

function ledgerTypeLabel(type: LedgerType): string {
  const labels: Record<LedgerType, string> = {
    recharge: "充值", grant: "赠送", debit: "扣费",
    refund: "退款", adjustment: "调整", expire: "过期",
    reversal: "冲正", reserve: "预留", release: "释放",
  };
  return labels[type];
}

function pricingStatusLabel(status: PricingVersion["status"]): string {
  if (status === "active") return "生效中";
  if (status === "retired") return "已退役";
  return "草稿";
}

function pricingStatusBadgeClass(status: PricingVersion["status"]): string {
  if (status === "active") return "bg-emerald-600 text-white hover:bg-emerald-600";
  if (status === "retired") return "bg-muted text-muted-foreground hover:bg-muted";
  return "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-50";
}

function makeDraft(policy: BillingPolicy): PolicyDraft {
  return {
    billingEnabled: policy.billingEnabled,
    billingMode: policy.billingMode,
    pricingVersion: policy.pricingVersion,
    targetMarginPct: String(policy.defaultTargetMarginBps / 100),
    multiplierPct: String(policy.organizationMultiplierBps / 100),
    allowNegativeBalance: policy.allowNegativeBalance,
    negativeLimitCredits: String(toCredits(policy.negativeLimitCreditsMicro)),
    lowBalanceThresholdCredits: String(toCredits(policy.lowBalanceThresholdCreditsMicro)),
    hardCapMode: policy.hardCapMode,
    showBalance: policy.showBalance,
    showUsageCredits: policy.showUsageCredits,
    showCost: policy.showCost,
    showGrossMargin: policy.showGrossMargin,
  };
}

function buildPolicyPatch(draft: PolicyDraft) {
  return {
    billingEnabled: draft.billingEnabled,
    billingMode: draft.billingMode,
    pricingVersion: draft.pricingVersion,
    defaultTargetMarginBps: Math.round((Number(draft.targetMarginPct) || 0) * 100),
    organizationMultiplierBps: Math.round((Number(draft.multiplierPct) || 0) * 100),
    allowNegativeBalance: draft.allowNegativeBalance,
    negativeLimitCreditsMicro: creditsToMicro(draft.negativeLimitCredits),
    lowBalanceThresholdCreditsMicro: creditsToMicro(draft.lowBalanceThresholdCredits),
    hardCapMode: draft.hardCapMode,
    showBalance: draft.showBalance,
    showUsageCredits: draft.showUsageCredits,
    showCost: draft.showCost,
    showGrossMargin: draft.showGrossMargin,
  };
}

// ----- 通用小组件 -----

function StatusBadge({ summary }: { summary: BillingSummary | null }) {
  if (!summary?.billingEnabled) return <Badge variant="secondary">未启用</Badge>;
  if (summary.lowBalance) return <Badge className="border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-50">低余额</Badge>;
  return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">计费中</Badge>;
}

function MetricTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 truncate text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

function ToggleRow({
  title, description, checked, onChange,
}: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function NoticeBar({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  if (!notice) return null;
  const tone =
    notice.kind === "error" ? "bg-destructive/10 text-destructive"
    : notice.kind === "success" ? "bg-success/10 text-success"
    : "bg-primary/10 text-primary";
  return (
    <div className={cn("mb-4 flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm", tone)}>
      <span className="flex-1">{notice.text}</span>
      <button onClick={onDismiss} className="opacity-70 hover:opacity-100"><X className="size-4" /></button>
    </div>
  );
}

function LedgerTable({ entries, readonly = false, onDrillRun }: {
  entries: LedgerEntry[];
  readonly?: boolean;
  onDrillRun?: (runId: string) => void;
}) {
  if (entries.length === 0) {
    return <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">暂无计费流水。</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>时间</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>积分变动</TableHead>
          <TableHead>余额</TableHead>
          {!readonly && <TableHead>收入/成本</TableHead>}
          <TableHead>会话/Run</TableHead>
          <TableHead>备注</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
            <TableCell><Badge variant="outline">{ledgerTypeLabel(entry.type)}</Badge></TableCell>
            <TableCell className={cn("font-mono tabular-nums", entry.creditsDeltaMicro < 0 ? "text-rose-600" : "text-emerald-700")}>
              {entry.creditsDeltaMicro > 0 ? "+" : ""}{formatCredits(toCredits(entry.creditsDeltaMicro))}
            </TableCell>
            <TableCell className="font-mono tabular-nums">{formatCredits(toCredits(entry.balanceAfterMicro))}</TableCell>
            {!readonly && (
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {formatYuanMicro(entry.revenueYuanMicro)} / {formatYuanMicro(entry.actualCostYuanMicro)}
              </TableCell>
            )}
            <TableCell className="whitespace-nowrap text-xs">
              {entry.runId && onDrillRun ? (
                <button className="font-mono text-primary hover:underline" onClick={() => onDrillRun(entry.runId!)}>
                  {entry.runId.slice(0, 12)}
                </button>
              ) : entry.runId ? (
                <span className="font-mono text-muted-foreground">{entry.runId.slice(0, 12)}</span>
              ) : entry.sessionId ? (
                <span className="font-mono text-muted-foreground">{entry.sessionId.slice(0, 12)}</span>
              ) : "-"}
            </TableCell>
            <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={entry.note || ""}>
              {entry.note || "-"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BillingOverview({
  summary, audit, readonly = false,
}: {
  summary: BillingSummary | null;
  audit?: BillingAuditSummary | null;
  readonly?: boolean;
}) {
  const reservedHint =
    summary && summary.reservedCredits > 0 ? `已预留 ${formatCredits(summary.reservedCredits)}` : "组织共享积分池";
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricTile label="积分余额" value={summary ? formatCredits(summary.balanceCredits) : "-"} hint={reservedHint} />
      <MetricTile label="本月消耗" value={summary ? formatCredits(summary.currentMonthCreditsUsed) : "-"} hint="按完成 run 聚合扣费" />
      <MetricTile label="计费状态" value={summary?.billingEnabled ? billingModeLabel(summary.billingMode) : "未启用"} hint={summary?.pricingVersion || "billing disabled"} />
      <MetricTile
        label={readonly ? "本月应收" : "7 日毛利"}
        value={readonly
          ? (summary ? `¥${summary.currentMonthRevenueYuan.toFixed(2)}` : "-")
          : formatPercentBps(audit?.grossMarginBps ?? summary?.currentMonthGrossMarginBps)}
        hint={readonly ? "按积分折算的客户侧金额" : "仅平台管理员可见"}
      />
    </div>
  );
}

function PricingDetailCard({ pricing }: { pricing: PricingVersion | null }) {
  if (!pricing) {
    return (
      <div className="rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground">
        当前未加载到 active 价格版本（可能尚未投影）
      </div>
    );
  }
  const creditYuan = pricing.creditValueYuanMicro / YUAN_MICRO;
  return (
    <div className="rounded-xl border bg-muted/20 p-3 text-xs leading-6 text-muted-foreground">
      <div className="font-medium text-foreground">当前价签 {pricing.version}</div>
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-4">
        <div>积分面值 ¥{creditYuan.toFixed(4)}/积分</div>
        <div>默认毛利 {(pricing.defaultTargetMarginBps / 100).toFixed(2)}%</div>
        <div>USD→CNY {pricing.fxRateToCny.toFixed(4)}</div>
        <div>生效日 {formatDate(pricing.effectiveFrom)}</div>
      </div>
    </div>
  );
}

// ----- 数据加载 -----

async function fetchBillingState(tenantId: string, includeAudit = true): Promise<BillingState> {
  const [summaryRes, policyRes, auditRes] = await Promise.all([
    authFetch(`/api/admin/billing/accounts?tenantId=${encodeURIComponent(tenantId)}`),
    authFetch(`/api/admin/billing/tenants/${encodeURIComponent(tenantId)}/policy`),
    includeAudit
      ? authFetch(`/api/admin/billing/audit?tenantId=${encodeURIComponent(tenantId)}&days=7`).catch(() => null)
      : Promise.resolve(null),
  ]);
  const summaryData = await summaryRes.json().catch(() => ({}));
  const policyData = await policyRes.json().catch(() => ({}));
  if (!summaryRes.ok) throw new Error((summaryData as { error?: string }).error || "加载账户失败");
  if (!policyRes.ok) throw new Error((policyData as { error?: string }).error || "加载计费策略失败");
  let audit: BillingAuditSummary | null = null;
  if (auditRes?.ok) {
    const auditData = await auditRes.json().catch(() => ({}));
    audit = (auditData as { audit?: BillingAuditSummary }).audit ?? null;
  }
  return {
    summary: (summaryData as { summary: BillingSummary }).summary,
    policy: (policyData as { policy: BillingPolicy }).policy,
    audit,
  };
}

// ============================================================
// PlatformBillingManager
// ============================================================

export function PlatformBillingManager() {
  // 只读平台 admin：保存策略/投影/账户调整等平台态写操作 disabled（组织侧 TenantBillingPanel 不受影响）
  const { platformReadOnly } = useAuth();
  const { tenants, loading: tenantsLoading } = useTenants();
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [pricingVersions, setPricingVersions] = useState<PricingVersion[]>([]);
  const [state, setState] = useState<BillingState>({ summary: null, policy: null, audit: null });
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [projecting, setProjecting] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustType, setAdjustType] =
    useState<"recharge" | "grant" | "refund" | "adjustment" | "expire" | "reversal">("recharge");
  const [adjustNote, setAdjustNote] = useState("");
  const [pricingVersionActions, setPricingVersionActions] = useState<ReactNode | null>(null);

  // tab 与 hash 同步
  const initialTab = useMemo<PlatformTab>(() => {
    const hash = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
    const params = new URLSearchParams(hash);
    const tab = params.get("tab") || hash;
    return TAB_HASH_KEYS[tab] || "overview";
  }, []);
  const [activeTab, setActiveTab] = useState<PlatformTab>(initialTab);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    params.set("tab", activeTab);
    const next = `#${params.toString()}`;
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  }, [activeTab]);

  // notice 自动消失
  useEffect(() => {
    if (!notice) return;
    const remain = notice.expiresAt - Date.now();
    if (remain <= 0) { setNotice(null); return; }
    const handle = window.setTimeout(() => setNotice(null), remain);
    return () => window.clearTimeout(handle);
  }, [notice]);

  // 跨 tab 联动：runId / sessionId 共享筛选
  const [drill, setDrill] = useState<{ runId?: string; sessionId?: string }>({});

  useEffect(() => {
    if (!selectedTenantId && tenants[0]) setSelectedTenantId(tenants[0].id);
  }, [selectedTenantId, tenants]);

  const loadPricingVersions = useCallback(async () => {
    const res = await authFetch("/api/admin/billing/pricing-versions");
    const data = await res.json().catch(() => ({}));
    if (res.ok) setPricingVersions((data as { pricingVersions?: PricingVersion[] }).pricingVersions ?? []);
  }, []);

  const load = useCallback(async () => {
    if (!selectedTenantId) return;
    setLoading(true);
    try {
      const next = await fetchBillingState(selectedTenantId, true);
      setState(next);
      setDraft(next.policy ? makeDraft(next.policy) : null);
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err), expiresAt: Date.now() + 8000 });
    } finally {
      setLoading(false);
    }
  }, [selectedTenantId]);

  useEffect(() => { void loadPricingVersions(); }, [loadPricingVersions]);
  useEffect(() => { void load(); }, [load]);

  const patchDraft = useCallback((recipe: (current: PolicyDraft) => PolicyDraft) => {
    setDraft((current) => current ? recipe(current) : current);
  }, []);

  const savePolicy = useCallback(async () => {
    if (!selectedTenantId || !draft) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/admin/billing/tenants/${encodeURIComponent(selectedTenantId)}/policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPolicyPatch(draft)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "保存计费策略失败");
      setNotice({ kind: "success", text: "计费策略已保存", expiresAt: Date.now() + 4000 });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err), expiresAt: Date.now() + 8000 });
    } finally {
      setSaving(false);
    }
  }, [draft, load, selectedTenantId]);

  const adjustAccount = useCallback(async () => {
    if (!selectedTenantId) return;
    const amount = Number(adjustAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      setNotice({ kind: "error", text: "请输入非 0 的积分变动值", expiresAt: Date.now() + 5000 });
      return;
    }
    setAdjusting(true);
    try {
      const res = await authFetch(`/api/admin/billing/accounts/${encodeURIComponent(selectedTenantId)}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditsDelta: amount, type: adjustType, note: adjustNote.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "调整积分失败");
      setNotice({ kind: "success", text: "账户调整已写入流水", expiresAt: Date.now() + 4000 });
      setAdjustAmount("");
      setAdjustNote("");
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err), expiresAt: Date.now() + 8000 });
    } finally {
      setAdjusting(false);
    }
  }, [adjustAmount, adjustNote, adjustType, load, selectedTenantId]);

  const projectNow = useCallback(async () => {
    setProjecting(true);
    try {
      const res = await authFetch("/api/admin/billing/project-now", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "手动投影失败");
      const result = data as { usageEventsInserted: number; debitEntriesInserted: number; lastProjectedSequence: number };
      const text = result.usageEventsInserted === 0 && result.debitEntriesInserted === 0
        ? `投影完成：无新增（last seq=${result.lastProjectedSequence}；若多实例部署，可能其他实例正在投影）`
        : `投影完成：新增 usage ${result.usageEventsInserted} 条 / debit ${result.debitEntriesInserted} 条（last seq=${result.lastProjectedSequence}）`;
      setNotice({ kind: "info", text, expiresAt: Date.now() + 7000 });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err), expiresAt: Date.now() + 8000 });
    } finally {
      setProjecting(false);
    }
  }, [load]);

  const selectedTenant = tenants.find((tenant) => tenant.id === selectedTenantId);
  const activePricing = useMemo(
    () => pricingVersions.find((v) => v.status === "active") ?? null,
    [pricingVersions],
  );

  const handleDrillRun = useCallback((runId: string) => {
    setDrill({ runId });
    setActiveTab("ledger");
  }, []);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <SettingsPanelHeader
        title="计费与积分"
        description="平台管理员配置组织积分账户、计费策略、价格版本与流水。客户侧只看到余额和消耗，不展示真实成本与毛利。"
        actions={
          <>
            <Select value={selectedTenantId} onValueChange={setSelectedTenantId} disabled={tenantsLoading || tenants.length === 0}>
              <SelectTrigger className="w-[240px] max-w-full">
                <SelectValue placeholder={tenantsLoading ? "加载组织中" : "选择组织"} />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((tenant) => (
                  <SelectItem key={tenant.id} value={tenant.id}>
                    {tenant.name} · {tenant.id}{tenant.disabled ? " · 停用" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeTab === "overview" && draft && (
              <Button size="sm" onClick={() => { void savePolicy(); }} disabled={platformReadOnly || saving || loading}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存策略
              </Button>
            )}
            {activeTab === "pricing-versions" && pricingVersionActions}
            <Button variant="outline" onClick={() => { void projectNow(); }} disabled={platformReadOnly || projecting}>
              {projecting ? <Loader2 className="size-4 animate-spin" /> : <ActionIcons.project className="size-4" />}
              投影 usage
            </Button>
            <Button variant="outline" onClick={() => { void load(); }} disabled={loading}>
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              刷新
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />

          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PlatformTab)} className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 rounded-lg border bg-card p-1 shadow-sm">
              <TabsList className="grid h-auto w-full grid-cols-2 gap-1 bg-transparent p-0 text-muted-foreground md:grid-cols-3 xl:grid-cols-5">
                <TabsTrigger value="overview" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">账户与策略</TabsTrigger>
                <TabsTrigger value="ledger" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">流水</TabsTrigger>
                <TabsTrigger value="usage-events" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">用量事件</TabsTrigger>
                <TabsTrigger value="pricing-versions" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">价格版本</TabsTrigger>
                <TabsTrigger value="audit" className="h-9 rounded-md px-3 data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none">平台审计</TabsTrigger>
              </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-auto pt-4">
              <TabsContent value="overview" className="mt-0 space-y-4">
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <EntityIcons.billing className="size-5 text-primary" />
                  <h3 className="truncate text-lg font-semibold">{selectedTenant?.name || selectedTenantId || "选择组织"}</h3>
                  <StatusBadge summary={state.summary} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">tenantId: {selectedTenantId || "-"}</p>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div>policy {state.policy?.policyVersion || "-"}</div>
                <div>updated {formatDateTime(state.policy?.updatedAt)}</div>
                <div>by {state.policy?.updatedBy || "-"}</div>
              </div>
            </CardContent>
          </Card>

          <BillingOverview summary={state.summary} audit={state.audit} />
          <PricingDetailCard pricing={activePricing} />

          {state.audit?.alerts.length ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="mb-1 flex items-center gap-2 font-medium"><CircleAlert className="size-4" />计费审计提醒</div>
              <ul className="space-y-1">{state.audit.alerts.map((alert) => <li key={alert}>· {alert}</li>)}</ul>
            </div>
          ) : null}

          {draft && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">计费策略</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 xl:grid-cols-2">
                  <ToggleRow title="启用计费" description="关闭时不扣费，客户前端也不会显示积分余额入口。" checked={draft.billingEnabled} onChange={(c) => patchDraft((s) => ({ ...s, billingEnabled: c }))} />
                  <ToggleRow title="允许负余额" description="仅用于信用客户或内部试运行，普通预付费客户建议关闭。" checked={draft.allowNegativeBalance} onChange={(c) => patchDraft((s) => ({ ...s, allowNegativeBalance: c }))} />
                  <ToggleRow title="客户显示余额" description="控制客户侧余额入口是否展示余额数字。" checked={draft.showBalance} onChange={(c) => patchDraft((s) => ({ ...s, showBalance: c }))} />
                  <ToggleRow title="客户显示积分消耗" description="控制客户侧是否展示本月和会话消耗。" checked={draft.showUsageCredits} onChange={(c) => patchDraft((s) => ({ ...s, showUsageCredits: c }))} />
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>计费模式</Label>
                    <Select value={draft.billingMode} onValueChange={(v) => patchDraft((s) => ({ ...s, billingMode: v as BillingMode }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="prepaid">预付费</SelectItem>
                        <SelectItem value="postpaid">后付费</SelectItem>
                        <SelectItem value="trial">试用</SelectItem>
                        <SelectItem value="internal">内部</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>硬封顶</Label>
                    <Select value={draft.hardCapMode} onValueChange={(v) => patchDraft((s) => ({ ...s, hardCapMode: v as HardCapMode }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">不封顶</SelectItem>
                        <SelectItem value="stop_before_run">余额不足拦截新任务</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>价格版本</Label>
                    <Select value={draft.pricingVersion} onValueChange={(v) => patchDraft((s) => ({ ...s, pricingVersion: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {pricingVersions.map((v) => (
                          <SelectItem key={v.version} value={v.version}>
                            {v.version}{v.status === "active" ? " · active" : v.status === "retired" ? " · retired" : " · draft"}
                          </SelectItem>
                        ))}
                        {!pricingVersions.some((v) => v.version === draft.pricingVersion) && (
                          <SelectItem value={draft.pricingVersion}>{draft.pricingVersion}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>目标毛利 %</Label>
                    <Input type="number" value={draft.targetMarginPct} onChange={(e) => patchDraft((s) => ({ ...s, targetMarginPct: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>组织倍率 %</Label>
                    <Input type="number" value={draft.multiplierPct} onChange={(e) => patchDraft((s) => ({ ...s, multiplierPct: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>低余额阈值</Label>
                    <Input type="number" value={draft.lowBalanceThresholdCredits} onChange={(e) => patchDraft((s) => ({ ...s, lowBalanceThresholdCredits: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>负余额额度</Label>
                    <Input type="number" value={draft.negativeLimitCredits} onChange={(e) => patchDraft((s) => ({ ...s, negativeLimitCredits: e.target.value }))} />
                  </div>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  <ToggleRow title="平台侧显示成本" description="仅影响有权限的管理视图，不应开放给客户。" checked={draft.showCost} onChange={(c) => patchDraft((s) => ({ ...s, showCost: c }))} />
                  <ToggleRow title="平台侧显示毛利" description="用于内部经营审计，默认不对组织管理员展示。" checked={draft.showGrossMargin} onChange={(c) => patchDraft((s) => ({ ...s, showGrossMargin: c }))} />
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle className="text-base">账户调整</CardTitle></CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-[160px_160px_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <Label>积分变动</Label>
                <Input type="number" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} placeholder="正数或负数" />
                <p className="text-xs text-muted-foreground">正数增加余额，负数扣减余额；类型用于流水归类。</p>
              </div>
              <div className="space-y-1.5">
                <Label>类型</Label>
                <Select value={adjustType} onValueChange={(v) => setAdjustType(v as typeof adjustType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recharge">充值</SelectItem>
                    <SelectItem value="grant">赠送</SelectItem>
                    <SelectItem value="refund">退款</SelectItem>
                    <SelectItem value="adjustment">调整</SelectItem>
                    <SelectItem value="expire">过期</SelectItem>
                    <SelectItem value="reversal">冲正</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>备注</Label>
                <Input value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="例如：首月试用赠送" />
              </div>
              <div className="flex justify-end md:col-span-3">
                <Button size="sm" variant="outline" onClick={() => { void adjustAccount(); }} disabled={platformReadOnly || adjusting || !adjustAmount.trim()}>
                  {adjusting ? <Loader2 className="size-4 animate-spin" /> : <EntityIcons.credits className="size-4" />}
                  写入流水
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ledger" className="mt-0 space-y-4">
          <LedgerView
            tenantId={selectedTenantId}
            initialRunId={drill.runId}
            initialSessionId={drill.sessionId}
            onDrillRun={(runId) => { setDrill({ runId }); setActiveTab("usage-events"); }}
          />
        </TabsContent>

        <TabsContent value="usage-events" className="mt-0 space-y-4">
          <UsageEventsView
            tenantId={selectedTenantId}
            initialRunId={drill.runId}
            initialSessionId={drill.sessionId}
            onDrillRun={handleDrillRun}
            onDrillSession={(sessionId) => { setDrill({ sessionId }); setActiveTab("ledger"); }}
          />
        </TabsContent>

        <TabsContent value="pricing-versions" className="mt-0 space-y-4">
          <PricingVersionsView
            pricingVersions={pricingVersions}
            onChanged={() => { void loadPricingVersions(); }}
            onNotice={setNotice}
            onActionsChange={setPricingVersionActions}
          />
        </TabsContent>

        <TabsContent value="audit" className="mt-0 space-y-4">
          <AuditView
            onJumpUnpriced={() => { setDrill({}); setActiveTab("usage-events"); }}
          />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// LedgerView (P0-3)
// ============================================================

function LedgerView({
  tenantId, initialRunId, initialSessionId, onDrillRun,
}: {
  tenantId: string;
  initialRunId?: string;
  initialSessionId?: string;
  onDrillRun: (runId: string) => void;
}) {
  const [filters, setFilters] = useState<{ type: LedgerType | "all"; sessionId: string; runId: string; from: string; to: string }>({
    type: "all",
    sessionId: initialSessionId ?? "",
    runId: initialRunId ?? "",
    from: "",
    to: "",
  });
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const initialRef = useRef({ initialRunId, initialSessionId });

  // 父 tab 切到这里时把 drill 透传到筛选条
  useEffect(() => {
    if (initialRunId && initialRunId !== initialRef.current.initialRunId) {
      setFilters((f) => ({ ...f, runId: initialRunId }));
      initialRef.current.initialRunId = initialRunId;
    }
    if (initialSessionId && initialSessionId !== initialRef.current.initialSessionId) {
      setFilters((f) => ({ ...f, sessionId: initialSessionId }));
      initialRef.current.initialSessionId = initialSessionId;
    }
  }, [initialRunId, initialSessionId]);

  const buildQuery = useCallback((cursor?: string | null) => {
    const params = new URLSearchParams();
    if (tenantId) params.set("tenantId", tenantId);
    if (filters.type !== "all") params.set("type", filters.type);
    if (filters.sessionId.trim()) params.set("sessionId", filters.sessionId.trim());
    if (filters.runId.trim()) params.set("runId", filters.runId.trim());
    if (filters.from) params.set("from", new Date(filters.from).toISOString());
    if (filters.to) params.set("to", new Date(filters.to).toISOString());
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    return params.toString();
  }, [filters, limit, tenantId]);

  const load = useCallback(async (cursor: string | null = null) => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/admin/billing/ledger?${buildQuery(cursor)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "加载流水失败");
      const payload = data as { entries: LedgerEntry[]; nextCursor?: string };
      setEntries((prev) => cursor ? [...prev, ...payload.entries] : payload.entries);
      setNextCursor(payload.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [buildQuery, tenantId]);

  // tenant 切换或首次进入：reset 并 load
  useEffect(() => { void load(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tenantId]);
  // initialRunId / initialSessionId 透传完成后重载
  useEffect(() => {
    if (filters.runId || filters.sessionId) void load(null);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [filters.runId, filters.sessionId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">计费流水</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 md:grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)_160px_160px_auto]">
          <Select value={filters.type} onValueChange={(v) => setFilters((f) => ({ ...f, type: v as LedgerType | "all" }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有类型</SelectItem>
              <SelectItem value="debit">扣费</SelectItem>
              <SelectItem value="recharge">充值</SelectItem>
              <SelectItem value="grant">赠送</SelectItem>
              <SelectItem value="refund">退款</SelectItem>
              <SelectItem value="adjustment">调整</SelectItem>
              <SelectItem value="reversal">冲正</SelectItem>
              <SelectItem value="expire">过期</SelectItem>
              <SelectItem value="reserve">预留</SelectItem>
              <SelectItem value="release">释放</SelectItem>
            </SelectContent>
          </Select>
          <Input placeholder="runId" value={filters.runId} onChange={(e) => setFilters((f) => ({ ...f, runId: e.target.value }))} />
          <Input placeholder="sessionId" value={filters.sessionId} onChange={(e) => setFilters((f) => ({ ...f, sessionId: e.target.value }))} />
          <Input type="datetime-local" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
          <Input type="datetime-local" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
          <div className="flex items-center gap-2">
            <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
              <SelectTrigger className="w-[90px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="200">200</SelectItem>
                <SelectItem value="500">500</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => { void load(null); }} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              查询
            </Button>
          </div>
        </div>

        {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        <LedgerTable entries={entries} onDrillRun={onDrillRun} />
        {nextCursor && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => { void load(nextCursor); }} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
              加载更多
            </Button>
          </div>
        )}
        <div className="text-right text-xs text-muted-foreground">已加载 {entries.length} 条</div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// UsageEventsView (P0-2)
// ============================================================

function UsageEventsView({
  tenantId, initialRunId, initialSessionId, onDrillRun, onDrillSession,
}: {
  tenantId: string;
  initialRunId?: string;
  initialSessionId?: string;
  onDrillRun: (runId: string) => void;
  onDrillSession: (sessionId: string) => void;
}) {
  const [filters, setFilters] = useState<{ runId: string; sessionId: string; billable: "all" | "true" | "false"; unpricedOnly: boolean; from: string; to: string }>({
    runId: initialRunId ?? "",
    sessionId: initialSessionId ?? "",
    billable: "all",
    unpricedOnly: false,
    from: "",
    to: "",
  });
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const initialRef = useRef({ initialRunId, initialSessionId });

  useEffect(() => {
    if (initialRunId && initialRunId !== initialRef.current.initialRunId) {
      setFilters((f) => ({ ...f, runId: initialRunId }));
      initialRef.current.initialRunId = initialRunId;
    }
    if (initialSessionId && initialSessionId !== initialRef.current.initialSessionId) {
      setFilters((f) => ({ ...f, sessionId: initialSessionId }));
      initialRef.current.initialSessionId = initialSessionId;
    }
  }, [initialRunId, initialSessionId]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (tenantId) params.set("tenantId", tenantId);
      if (filters.runId.trim()) params.set("runId", filters.runId.trim());
      if (filters.sessionId.trim()) params.set("sessionId", filters.sessionId.trim());
      if (filters.billable !== "all") params.set("billable", filters.billable);
      if (filters.unpricedOnly) params.set("unpricedOnly", "true");
      if (filters.from) params.set("from", new Date(filters.from).toISOString());
      if (filters.to) params.set("to", new Date(filters.to).toISOString());
      params.set("limit", String(limit));
      const res = await authFetch(`/api/admin/billing/usage-events?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "加载用量事件失败");
      setEvents((data as { events: UsageEvent[] }).events ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filters, limit, tenantId]);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tenantId]);
  useEffect(() => {
    if (filters.runId || filters.sessionId || filters.unpricedOnly) void load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [filters.runId, filters.sessionId, filters.unpricedOnly]);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">用量事件</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_140px_160px_160px_auto]">
          <Input placeholder="runId" value={filters.runId} onChange={(e) => setFilters((f) => ({ ...f, runId: e.target.value }))} />
          <Input placeholder="sessionId" value={filters.sessionId} onChange={(e) => setFilters((f) => ({ ...f, sessionId: e.target.value }))} />
          <Select value={filters.billable} onValueChange={(v) => setFilters((f) => ({ ...f, billable: v as "all" | "true" | "false" }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">计费状态：全部</SelectItem>
              <SelectItem value="true">仅计费</SelectItem>
              <SelectItem value="false">仅不计费</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.unpricedOnly ? "true" : "false"} onValueChange={(v) => setFilters((f) => ({ ...f, unpricedOnly: v === "true" }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="false">全部成本</SelectItem>
              <SelectItem value="true">仅未定价</SelectItem>
            </SelectContent>
          </Select>
          <Input type="datetime-local" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
          <Input type="datetime-local" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
          <div className="flex items-center gap-2">
            <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
              <SelectTrigger className="w-[90px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="200">200</SelectItem>
                <SelectItem value="500">500</SelectItem>
                <SelectItem value="1000">1000</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => { void load(); }} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              查询
            </Button>
          </div>
        </div>
        {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        {events.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">无符合条件的用量事件。</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>run / session</TableHead>
                <TableHead>input/output</TableHead>
                <TableHead>cache</TableHead>
                <TableHead>成本(¥)</TableHead>
                <TableHead>计费</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell className="text-xs">{e.username}</TableCell>
                  <TableCell className="text-xs">
                    <div className="font-mono">{e.modelValue}</div>
                    {e.actualModel && e.actualModel !== e.modelValue && (
                      <div className="text-muted-foreground">→ {e.actualModel}</div>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {e.runId && (
                      <div>
                        <button className="font-mono text-primary hover:underline" onClick={() => onDrillRun(e.runId!)}>
                          run:{e.runId.slice(0, 10)}
                        </button>
                      </div>
                    )}
                    {e.sessionId && (
                      <div>
                        <button className="font-mono text-muted-foreground hover:underline" onClick={() => onDrillSession(e.sessionId!)}>
                          sess:{e.sessionId.slice(0, 10)}
                        </button>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums text-xs">{e.inputTokens.toLocaleString()} / {e.outputTokens.toLocaleString()}</TableCell>
                  <TableCell className="font-mono tabular-nums text-xs text-muted-foreground">
                    r:{e.cachedInputTokens.toLocaleString()} w:{e.cacheCreationTokens.toLocaleString()}
                  </TableCell>
                  <TableCell className={cn("font-mono tabular-nums text-xs", e.actualCostYuanMicro === 0 && (e.inputTokens > 0 || e.outputTokens > 0) ? "text-amber-600" : "")}>
                    {formatYuanMicro(e.actualCostYuanMicro)}
                  </TableCell>
                  <TableCell>{e.billable ? <Badge variant="outline">计费</Badge> : <Badge variant="secondary">不计</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="text-right text-xs text-muted-foreground">已加载 {events.length} 条 · 受 limit 限制；进一步查询请缩小时间窗口</div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// PricingVersionsView (P0-1)
// ============================================================

function PricingVersionsView({
  pricingVersions, onChanged, onNotice, onActionsChange,
}: {
  pricingVersions: PricingVersion[];
  onChanged: () => void;
  onNotice: (notice: Notice) => void;
  onActionsChange?: (actions: ReactNode | null) => void;
}) {
  // 只读平台 admin：新建/激活/编辑价格版本 disabled（该视图仅平台态使用）
  const { platformReadOnly } = useAuth();
  const [editing, setEditing] = useState<PricingVersion | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const callPatch = useCallback(async (version: string, patch: Record<string, unknown>, label: string) => {
    setBusy(version);
    try {
      const res = await authFetch(`/api/admin/billing/pricing-versions/${encodeURIComponent(version)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `${label}失败`);
      onNotice({ kind: "success", text: `${label}成功：${version}`, expiresAt: Date.now() + 4000 });
      onChanged();
    } catch (err) {
      onNotice({ kind: "error", text: err instanceof Error ? err.message : String(err), expiresAt: Date.now() + 8000 });
    } finally {
      setBusy(null);
    }
  }, [onChanged, onNotice]);

  const actions = useMemo(() => (
    <Button size="sm" onClick={() => setCreating(true)} disabled={platformReadOnly}>
      <Plus className="size-4" />
      新建价格版本
    </Button>
  ), [platformReadOnly]);

  useEffect(() => {
    onActionsChange?.(actions);
    return () => onActionsChange?.(null);
  }, [actions, onActionsChange]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">价格版本</CardTitle>
      </CardHeader>
      <CardContent>
        {pricingVersions.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">尚无价格版本。</div>
        ) : (
          <Table className="min-w-max">
            <TableHeader className="[&_th]:whitespace-nowrap">
              <TableRow>
                <TableHead>版本号</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>积分面值</TableHead>
                <TableHead>默认毛利</TableHead>
                <TableHead>fxRate</TableHead>
                <TableHead>生效日</TableHead>
                <TableHead>修改人</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:whitespace-nowrap">
              {pricingVersions.map((v) => (
                <TableRow key={v.version}>
                  <TableCell className="font-mono text-xs">{v.version}</TableCell>
                  <TableCell className="text-xs">{v.name}</TableCell>
                  <TableCell><Badge className={pricingStatusBadgeClass(v.status)}>{pricingStatusLabel(v.status)}</Badge></TableCell>
                  <TableCell className="font-mono tabular-nums text-xs">¥{(v.creditValueYuanMicro / YUAN_MICRO).toFixed(4)}</TableCell>
                  <TableCell className="font-mono tabular-nums text-xs">{(v.defaultTargetMarginBps / 100).toFixed(2)}%</TableCell>
                  <TableCell className="font-mono tabular-nums text-xs">{v.fxRateToCny.toFixed(4)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(v.effectiveFrom)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{v.updatedBy || v.createdBy}</TableCell>
                  <TableCell className="space-x-2 whitespace-nowrap text-right">
                    {v.status !== "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={platformReadOnly || busy === v.version || v.status === "retired"}
                        onClick={() => {
                          if (!window.confirm(`激活 ${v.version}？\n\n旧的 active 版本会被自动改为 retired；历史 ledger 不会被重算。`)) return;
                          void callPatch(v.version, { status: "active" }, "激活");
                        }}
                      >激活</Button>
                    )}
                    {v.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled
                        title="当前 active 版本不能直接退役，请先激活另一个版本"
                      >退役</Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setEditing(v)} disabled={platformReadOnly || busy === v.version || v.status === "retired"}>
                      编辑
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <PricingVersionFormDialog
        open={creating}
        onOpenChange={(o) => { if (!o) setCreating(false); }}
        title="新建价格版本"
        onSubmit={async (input) => {
          const res = await authFetch("/api/admin/billing/pricing-versions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error((data as { error?: string }).error || "创建失败");
          onNotice({ kind: "success", text: `已创建：${input.version}`, expiresAt: Date.now() + 4000 });
          setCreating(false);
          onChanged();
        }}
      />
      <PricingVersionFormDialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        title={editing ? `编辑 ${editing.version}` : ""}
        initial={editing ?? undefined}
        editMode
        onSubmit={async (input) => {
          if (!editing) return;
          await callPatch(editing.version, {
            name: input.name,
            creditValueYuanMicro: input.creditValueYuanMicro,
            defaultTargetMarginBps: input.defaultTargetMarginBps,
            fxRateToCny: input.fxRateToCny,
          }, "更新");
          setEditing(null);
        }}
      />
    </Card>
  );
}

function PricingVersionFormDialog({
  open, onOpenChange, title, onSubmit, initial, editMode = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial?: PricingVersion;
  editMode?: boolean;
  onSubmit: (input: {
    version: string; name: string; status?: "draft" | "active";
    creditValueYuanMicro: number; defaultTargetMarginBps: number; fxRateToCny: number;
  }) => Promise<void>;
}) {
  const [version, setVersion] = useState(initial?.version ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [status, setStatus] = useState<"draft" | "active">(initial?.status === "active" ? "active" : "draft");
  const [creditYuan, setCreditYuan] = useState(
    initial ? String(initial.creditValueYuanMicro / YUAN_MICRO) : "0.01",
  );
  const [marginPct, setMarginPct] = useState(
    initial ? String(initial.defaultTargetMarginBps / 100) : "60",
  );
  const [fxRate, setFxRate] = useState(initial ? String(initial.fxRateToCny) : "7.2");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setVersion(initial?.version ?? "");
    setName(initial?.name ?? "");
    setStatus(initial?.status === "active" ? "active" : "draft");
    setCreditYuan(initial ? String(initial.creditValueYuanMicro / YUAN_MICRO) : "0.01");
    setMarginPct(initial ? String(initial.defaultTargetMarginBps / 100) : "60");
    setFxRate(initial ? String(initial.fxRateToCny) : "7.2");
    setError(null);
  }, [open, initial]);

  const handleSubmit = async () => {
    setError(null);
    if (!editMode && !/^[a-z0-9][a-z0-9.\-]{2,99}$/.test(version)) {
      setError("版本号必须以小写字母或数字开头，仅含小写字母/数字/点/横线，3-100 字符");
      return;
    }
    if (!name.trim()) { setError("名称不能为空"); return; }
    const creditMicro = Math.round(Number(creditYuan) * YUAN_MICRO);
    const marginBps = Math.round(Number(marginPct) * 100);
    const fx = Number(fxRate);
    if (!Number.isFinite(creditMicro) || creditMicro < 1) { setError("积分面值必须 > 0"); return; }
    if (!Number.isFinite(marginBps) || marginBps < 0 || marginBps > 9500) { setError("默认毛利必须在 0-95% 之间"); return; }
    if (!Number.isFinite(fx) || fx <= 0 || fx > 50) { setError("fxRate 必须在 0-50 之间"); return; }

    setSubmitting(true);
    try {
      await onSubmit({
        version: version.trim(),
        name: name.trim(),
        ...(editMode ? {} : { status }),
        creditValueYuanMicro: creditMicro,
        defaultTargetMarginBps: marginBps,
        fxRateToCny: fx,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            积分面值与默认毛利会写入 ledger 留痕。改值仅对此后新增的 usage event 与 settleRunDebit 生效，历史数据不重算。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>版本号</Label>
            <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="如 2026-07-01-v1" disabled={editMode} />
          </div>
          <div className="space-y-1.5">
            <Label>名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 GTM Q3 调价" />
          </div>
          {!editMode && (
            <div className="space-y-1.5">
              <Label>初始状态</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as "draft" | "active")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">草稿</SelectItem>
                  <SelectItem value="active">立即激活（旧 active 会被退役）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>积分面值 (¥/积分)</Label>
              <Input type="number" step="0.0001" value={creditYuan} onChange={(e) => setCreditYuan(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>默认毛利 %</Label>
              <Input type="number" step="0.5" value={marginPct} onChange={(e) => setMarginPct(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>USD→CNY</Label>
              <Input type="number" step="0.01" value={fxRate} onChange={(e) => setFxRate(e.target.value)} />
            </div>
          </div>
          {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
          <Button onClick={() => { void handleSubmit(); }} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            提交
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// AuditView (P0-4)
// ============================================================

function AuditView({ onJumpUnpriced }: { onJumpUnpriced: () => void }) {
  const [days, setDays] = useState(7);
  const [audit, setAudit] = useState<BillingAuditSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await authFetch(`/api/admin/billing/audit?days=${days}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "加载审计失败");
      setAudit((data as { audit: BillingAuditSummary }).audit);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">平台审计</CardTitle>
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">时间窗口</Label>
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">最近 1 天</SelectItem>
                <SelectItem value="7">最近 7 天</SelectItem>
                <SelectItem value="14">最近 14 天</SelectItem>
                <SelectItem value="30">最近 30 天</SelectItem>
                <SelectItem value="60">最近 60 天</SelectItem>
                <SelectItem value="90">最近 90 天</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => { void load(); }} disabled={loading}>
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricTile label="本期成本" value={audit ? formatYuanMicro(audit.actualCostYuanMicro) : "-"} hint="模型 API 实际成本（CNY）" />
            <MetricTile label="本期收入" value={audit ? formatYuanMicro(audit.revenueYuanMicro) : "-"} hint="按积分扣费折算的客户侧应收" />
            <MetricTile label="本期毛利" value={audit ? formatYuanMicro(audit.grossProfitYuanMicro) : "-"} hint="收入 − 实际成本" />
            <MetricTile label="毛利率" value={audit ? formatPercentBps(audit.grossMarginBps) : "-"} hint="低于 45% 触发告警" />
          </div>

          {audit?.alerts.length ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="mb-1 flex items-center gap-2 font-medium"><CircleAlert className="size-4" />告警</div>
              <ul className="space-y-1">{audit.alerts.map((alert) => <li key={alert}>· {alert}</li>)}</ul>
            </div>
          ) : null}

          {audit && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline" className="px-2.5 py-1">
                未定价 usage 事件：{audit.unpricedUsageEvents}
              </Badge>
              {audit.unpricedUsageEvents > 0 && (
                <Button size="sm" variant="outline" onClick={onJumpUnpriced}>
                  跳到「用量事件」筛 cost=0
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">低余额租户</CardTitle></CardHeader>
        <CardContent>
          {audit?.lowBalanceTenants.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>租户</TableHead>
                  <TableHead>余额</TableHead>
                  <TableHead>阈值</TableHead>
                  <TableHead>差额</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.lowBalanceTenants.map((row) => {
                  const balance = row.balanceCreditsMicro / CREDIT_MICRO;
                  const threshold = row.thresholdCreditsMicro / CREDIT_MICRO;
                  return (
                    <TableRow key={row.tenantId}>
                      <TableCell className="font-mono text-xs">{row.tenantId}</TableCell>
                      <TableCell className="font-mono tabular-nums">{formatCredits(balance)}</TableCell>
                      <TableCell className="font-mono tabular-nums text-muted-foreground">{formatCredits(threshold)}</TableCell>
                      <TableCell className="font-mono tabular-nums text-rose-600">{formatCredits(balance - threshold)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">所有租户余额都高于阈值。</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">按日明细 (Beijing TZ)</CardTitle></CardHeader>
        <CardContent>
          {audit?.daily && audit.daily.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>成本</TableHead>
                  <TableHead>收入</TableHead>
                  <TableHead>毛利</TableHead>
                  <TableHead>积分扣费</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.daily.map((d) => (
                  <TableRow key={d.date}>
                    <TableCell className="whitespace-nowrap text-xs">{d.date}</TableCell>
                    <TableCell className="font-mono tabular-nums text-xs">{formatYuanMicro(d.actualCostYuanMicro)}</TableCell>
                    <TableCell className="font-mono tabular-nums text-xs">{formatYuanMicro(d.revenueYuanMicro)}</TableCell>
                    <TableCell className="font-mono tabular-nums text-xs">{formatYuanMicro(d.grossProfitYuanMicro)}</TableCell>
                    <TableCell className="font-mono tabular-nums text-xs">{formatCredits(toCredits(d.creditsChargedMicro))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">无日明细数据。</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// TenantBillingPanel (组织管理员只读视图)
// ============================================================

export function TenantBillingPanel({ tenantId, tenantName }: { tenantId: string; tenantName?: string }) {
  const [state, setState] = useState<BillingState>({ summary: null, policy: null, audit: null });
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const next = await fetchBillingState(tenantId, false);
      setState(next);
      const res = await authFetch(`/api/admin/billing/ledger?tenantId=${encodeURIComponent(tenantId)}&limit=50`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setLedger((data as { entries: LedgerEntry[] }).entries ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="计费"
        description="组织管理员只查看余额、消耗和流水；充值、策略与封顶由平台管理员统一维护。"
        actions={<Button variant="outline" onClick={() => { void load(); }} disabled={loading}><RefreshCw className={cn("size-4", loading && "animate-spin")} />刷新</Button>}
      />
      <div className="min-h-0 flex-1 space-y-5 overflow-auto">
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <div className="flex items-center gap-2">
              <EntityIcons.billing className="size-5 text-primary" />
              <h3 className="text-lg font-semibold">{tenantName || tenantId}</h3>
              <StatusBadge summary={state.summary} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {state.summary?.billingEnabled
                ? `${billingModeLabel(state.summary.billingMode)} · ${hardCapLabel(state.policy?.hardCapMode ?? "none")}`
                : "当前组织尚未启用积分计费"}
            </p>
            {state.policy?.updatedBy && (
              <p className="mt-1 text-xs text-muted-foreground">
                策略最后由 {state.policy.updatedBy} 于 {formatDateTime(state.policy.updatedAt)} 更新
              </p>
            )}
          </div>
          {state.summary?.lowBalance && (
            <Badge className="border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-50">余额接近阈值</Badge>
          )}
        </CardContent>
      </Card>
      <BillingOverview summary={state.summary} readonly />
      {!state.summary?.billingEnabled ? (
        <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          平台尚未为本组织启用积分计费。启用前，聊天页不会显示积分余额，也不会产生客户侧扣费流水。
        </div>
      ) : null}
      <Card>
        <CardHeader><CardTitle className="text-base">最近流水</CardTitle></CardHeader>
        <CardContent>
          <LedgerTable entries={ledger} readonly />
        </CardContent>
      </Card>
      {state.policy && (
        <div className="rounded-xl border bg-muted/20 p-4 text-xs leading-5 text-muted-foreground">
          当前策略：{billingModeLabel(state.policy.billingMode)}，{hardCapLabel(state.policy.hardCapMode)}；
          低余额阈值 {formatCredits(toCredits(state.policy.lowBalanceThresholdCreditsMicro))} 积分。
        </div>
      )}
      </div>
    </div>
  );
}
