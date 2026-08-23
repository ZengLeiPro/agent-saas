import { useEffect, useMemo, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";

import { TenantDebugModeSetting } from "@/components/Governance/DebugModeSettings";
import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import { EntityIcons } from "@/lib/icons";
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";

interface EntitlementRecord {
  source: string;
  status: string;
  version: number;
}

interface TenantPolicyDefinition {
  label: string;
  description: string;
  group: string;
  groupLabel: string;
  valueType: "boolean" | "enum";
  options?: Array<{ value: string; label: string }>;
}

interface TenantPolicy {
  policyKey: string;
  value: unknown;
  source: string;
  version: number;
  definition?: TenantPolicyDefinition;
  allowedActions?: Array<{ id: string }>;
}

interface EntitlementResponse {
  entitlement: EntitlementRecord | null;
  scopes: unknown[];
  policies: TenantPolicy[];
}

interface GovernancePreview {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  impact: {
    from: "inherited" | "allow" | "deny";
    to: "allow" | "deny";
  };
  changeId: string;
}

interface GovernanceReceipt {
  changeId: string;
  auditId: string;
  effectiveAt?: string;
}

const sourceLabels: Record<string, string> = {
  governance: "组织覆盖",
  legacy_projection: "沿用现有设置",
  plan_default: "套餐默认",
  platform_override: "平台配置",
  legacy_migrated: "历史配置",
};

const statusLabels: Record<string, string> = {
  active: "有效",
  trial: "试用",
  suspended: "已暂停",
  expired: "已过期",
};

function policyValueLabel(policy: TenantPolicy): string {
  if (typeof policy.value === "boolean") return policy.value ? "已允许" : "已禁止";
  const matched = policy.definition?.options?.find(option => option.value === String(policy.value));
  if (matched) return matched.label;
  if (policy.value === null) return "未配置";
  if (["string", "number"].includes(typeof policy.value)) return String(policy.value);
  return "复杂配置";
}

function policyCanEdit(policy: TenantPolicy): boolean {
  return policy.definition?.valueType === "boolean"
    && typeof policy.value === "boolean"
    && policy.allowedActions?.some(action => action.id === "edit_policy") === true;
}

function PolicyEditor({
  tenantId,
  policy,
  onCommitted,
}: {
  tenantId: string;
  policy: TenantPolicy;
  onCommitted: () => void;
}) {
  const currentValue = typeof policy.value === "boolean" ? policy.value : null;
  const label = policy.definition?.label ?? policy.policyKey;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentValue ?? false);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<GovernancePreview | null>(null);
  const [receipt, setReceipt] = useState<GovernanceReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = policyCanEdit(policy);
  const changed = currentValue !== null && value !== currentValue;

  useEffect(() => {
    if (typeof policy.value === "boolean") setValue(policy.value);
  }, [policy.value]);

  const resetDraft = () => {
    setEditing(false);
    setValue(currentValue ?? false);
    setReason("");
    setPreview(null);
    setError(null);
  };

  const runPreview = async () => {
    if (!changed || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      setPreview(await governanceAccessApi.previewPolicy<GovernancePreview>(policy.policyKey, {
        expectedVersion: policy.version,
        value,
        reason: reason.trim(),
      }, tenantId));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await governanceAccessApi.updatePolicy<GovernanceReceipt>(policy.policyKey, {
        expectedVersion: policy.version,
        value,
        reason: reason.trim(),
        previewId: preview.previewId,
        baselineDigest: preview.baselineDigest,
        expiresAt: preview.expiresAt,
      }, tenantId);
      setReceipt(result);
      setEditing(false);
      setReason("");
      setPreview(null);
      onCommitted();
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <article className="rounded-xl border bg-background p-4" data-policy-key={policy.policyKey}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-medium">{label}</h4>
          <Badge variant={policy.value === true ? "secondary" : "outline"}>{policyValueLabel(policy)}</Badge>
          <Badge variant="outline">{sourceLabels[policy.source] ?? policy.source}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {policy.definition?.description ?? "该策略尚未提供业务说明，因此保持只读。"}
        </p>
      </div>
      {canEdit && !editing ? <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`修改${label}`}
        onClick={() => { setEditing(true); setReceipt(null); }}
      >修改</Button> : null}
    </div>

    <details className="mt-3 text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer select-none">技术详情</summary>
      <div className="mt-2 break-all rounded-lg bg-muted/40 p-3 font-mono">
        {policy.policyKey} · v{policy.version} · {policy.source}
      </div>
    </details>

    {!canEdit ? <div className="mt-3 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {policy.definition?.valueType === "enum"
        ? "该策略使用多值配置，当前页面只读，避免被错误改写为开关值。"
        : "当前账号或策略类型不允许在此修改。"}
    </div> : null}

    {editing ? <div className="mt-4 space-y-3 rounded-xl border bg-muted/20 p-4">
      <div>
        <div className="text-sm font-medium">修改为</div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:max-w-xs" role="group" aria-label={`${label}目标状态`}>
          <Button type="button" variant={value ? "default" : "outline"} aria-pressed={value} onClick={() => { setValue(true); setPreview(null); }}>允许</Button>
          <Button type="button" variant={!value ? "default" : "outline"} aria-pressed={!value} onClick={() => { setValue(false); setPreview(null); }}>禁止</Button>
        </div>
      </div>
      <label className="grid gap-1 text-sm">
        <span>变更原因</span>
        <Input
          aria-label={`${policy.policyKey} 变更原因`}
          placeholder="说明为什么要修改（至少 3 个字符）"
          value={reason}
          disabled={busy}
          onChange={event => { setReason(event.target.value); setPreview(null); }}
        />
      </label>
      {preview ? <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
        <div className="font-medium">影响预览</div>
        <div className="mt-1">{currentValue ? "允许" : "禁止"} → {value ? "允许" : "禁止"}</div>
        <div className="mt-1 text-xs text-muted-foreground">预览有效至 {new Date(preview.expiresAt).toLocaleString()}</div>
      </div> : null}
      {error ? <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={resetDraft}>取消</Button>
        {preview ? <Button type="button" disabled={busy || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void commit()}>{busy ? "正在应用" : "确认应用"}</Button>
          : <Button type="button" disabled={busy || !changed || reason.trim().length < 3} onClick={() => void runPreview()}>{busy ? "正在预览" : "预览变更"}</Button>}
      </div>
    </div> : null}

    {receipt ? <div role="status" className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
      已应用策略变更 · Change ID：{receipt.changeId} · Audit ID：{receipt.auditId}
    </div> : null}
  </article>;
}

function Loading() {
  return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取权限策略…</div>;
}

export function OrganizationPoliciesPage({ tenantId }: { tenantId: string }) {
  const request = useMemo(() => () => governanceAccessApi.getEntitlements<EntitlementResponse>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `policies:${tenantId}`);
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [overridesOnly, setOverridesOnly] = useState(false);

  const policies = useMemo(() => (data?.policies ?? []).filter(policy =>
    policy.policyKey !== "runtime.debug_mode.allowed" && policy.policyKey !== "runtime.debug_mode.enabled"
  ), [data?.policies]);

  const groups = useMemo(() => {
    const seen = new Map<string, string>();
    for (const policy of policies) {
      const key = policy.definition?.group ?? "other";
      if (!seen.has(key)) seen.set(key, policy.definition?.groupLabel ?? "其他策略");
    }
    return Array.from(seen, ([value, label]) => ({ value, label }));
  }, [policies]);

  const filteredPolicies = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    return policies.filter(policy => {
      const matchesGroup = group === "all" || (policy.definition?.group ?? "other") === group;
      const matchesSource = !overridesOnly || policy.source === "governance";
      const haystack = `${policy.definition?.label ?? ""} ${policy.definition?.description ?? ""} ${policy.policyKey}`.toLocaleLowerCase();
      return matchesGroup && matchesSource && (!keyword || haystack.includes(keyword));
    });
  }, [group, overridesOnly, policies, search]);

  const groupedPolicies = useMemo(() => {
    const result = new Map<string, { label: string; policies: TenantPolicy[] }>();
    for (const policy of filteredPolicies) {
      const key = policy.definition?.group ?? "other";
      const current = result.get(key) ?? { label: policy.definition?.groupLabel ?? "其他策略", policies: [] };
      current.policies.push(policy);
      result.set(key, current);
    }
    return Array.from(result.values());
  }, [filteredPolicies]);

  if (loading) return <Loading />;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;

  const overrideCount = policies.filter(policy => policy.source === "governance").length;
  const readOnlyCount = policies.filter(policy => !policyCanEdit(policy)).length;
  const clearFilters = () => { setSearch(""); setGroup("all"); setOverridesOnly(false); };

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold">权限策略</h2>
        <p className="mt-1 text-sm text-muted-foreground">按业务能力查看组织当前权限；只有发起修改时才展开原因、影响预览和确认步骤。</p>
      </div>
      <Button type="button" variant="outline" onClick={retry}>刷新</Button>
    </div>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">平台权益</div><div className="mt-1 font-medium">{data?.entitlement ? statusLabels[data.entitlement.status] ?? data.entitlement.status : "未配置"}</div><div className="mt-1 text-xs text-muted-foreground">{data?.entitlement ? sourceLabels[data.entitlement.source] ?? data.entitlement.source : "等待平台配置"}</div></div>
      <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">组织策略</div><div className="mt-1 text-2xl font-semibold">{policies.length}</div><div className="mt-1 text-xs text-muted-foreground">不含成员调试模式</div></div>
      <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">组织覆盖</div><div className="mt-1 text-2xl font-semibold">{overrideCount}</div><div className="mt-1 text-xs text-muted-foreground">由本组织明确设置</div></div>
      <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">只读策略</div><div className="mt-1 text-2xl font-semibold">{readOnlyCount}</div><div className="mt-1 text-xs text-muted-foreground">受类型或当前权限限制</div></div>
    </div>

    <section className="rounded-xl border bg-card p-4" aria-labelledby="debug-policy-title">
      <div className="mb-3 flex items-center gap-2"><EntityIcons.admin className="size-4" /><h3 id="debug-policy-title" className="font-medium">成员调试模式</h3></div>
      <TenantDebugModeSetting tenantId={tenantId} level="organization" />
    </section>

    <section className="space-y-4" aria-labelledby="organization-policy-title">
      <div className="flex items-center gap-2"><SlidersHorizontal className="size-4" /><h3 id="organization-policy-title" className="font-medium">组织策略</h3></div>
      <div className="grid gap-3 rounded-xl border bg-card p-4 lg:grid-cols-[minmax(240px,1fr)_220px_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="搜索权限策略" className="pl-9" placeholder="搜索策略名称、说明或技术键" value={search} onChange={event => setSearch(event.target.value)} />
        </div>
        <select aria-label="按策略分类筛选" className="h-10 rounded-md border bg-background px-3 text-sm" value={group} onChange={event => setGroup(event.target.value)}>
          <option value="all">全部分类</option>
          {groups.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <Button type="button" variant={overridesOnly ? "default" : "outline"} aria-pressed={overridesOnly} onClick={() => setOverridesOnly(value => !value)}>仅看组织覆盖</Button>
      </div>

      {groupedPolicies.length ? groupedPolicies.map(item => <section key={item.label} className="space-y-3" aria-label={item.label}>
        <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">{item.label}</h4><Badge variant="outline">{item.policies.length} 项</Badge></div>
        <div className="grid gap-3 xl:grid-cols-2">{item.policies.map(policy => <PolicyEditor key={policy.policyKey} tenantId={tenantId} policy={policy} onCommitted={retry} />)}</div>
      </section>) : <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        <div>当前筛选条件下没有权限策略。</div>
        <Button type="button" variant="link" className="mt-2" onClick={clearFilters}>清除筛选</Button>
      </div>}
    </section>
  </div>;
}
