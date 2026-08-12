import { useMemo, useState } from "react";
import { Boxes, TriangleAlert } from "lucide-react";

import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import { EntityIcons } from "@/lib/icons";
import { governanceAccessApi, governanceResourcesApi } from "@agent/shared/lib/governanceApi";

interface EntitlementRecord {
  tenantId: string;
  source: string;
  status: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  limits: Record<string, number>;
  version: number;
  updateReason?: string;
}
interface ResourceScope { resourceType: string; mode: "all" | "selected"; resourceIds: string[]; source: string; version: number; allowedActions: Array<{ id: string; label: string }> }
interface EntitlementResourceCatalog { resourceType: string; items: Array<{ resourceId: string; label: string; version: number }> }
interface TenantPolicy { policyKey: string; value: unknown; source: string; version: number }
interface EntitlementResponse {
  entitlement: EntitlementRecord | null;
  scopes: ResourceScope[];
  policies: TenantPolicy[];
  allowedActions: Array<{ id: string; label: string; change: { status: string }; requiresReason: boolean }>;
}
interface PlatformAdminRecord { userId: string; status: string; source: string; version: number; createdAt?: string; updatedAt?: string; directoryProfile?: { username: string; displayName: string; accountStatus: "active" | "disabled" } | null }
interface PlatformAdminResponse { platformAdmins: PlatformAdminRecord[] }
interface TenantLifecycleResponse {
  tenantId: string;
  status: "active" | "suspended";
  updatedAt: string;
  allowedActions: Array<{ id: string; label: string; action: "suspend" | "resume"; requiresReason: boolean }>;
}
interface GovernancePreviewToken { previewId: string; baselineDigest: string; expiresAt: string }
interface EntitlementPreview extends GovernancePreviewToken {
  impact: { currentVersion: number; nextVersion: number; fromStatus: string; toStatus: string; blockers: string[]; reversible: boolean; effectiveMode: string };
}
interface ScopePreview extends GovernancePreviewToken {
  impact: { currentVersion: number; nextVersion: number; from: { mode: string; resourceCount: number }; to: { mode: string; resourceCount: number }; blockers: string[]; reversible: boolean; effectiveMode: string };
}
interface GovernanceReceipt {
  version?: number; status?: string; changeId: string; auditId: string; effectiveAt: string;
  projectionStatus?: string; projectionId?: string; auditCompletion?: "pending"; auditProjectionId?: string;
}
interface TenantLifecyclePreview extends GovernancePreviewToken {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  impact: { tenantId: string; from: string; to: string; blockers: string[]; reversible: boolean; effectiveMode: string };
}

const statusLabels: Record<string, string> = {
  trial: "试用中",
  active: "启用",
  enabled: "启用",
  disabled: "禁用",
  suspended: "已暂停",
  pending: "等待中",
  running: "执行中",
  completed: "已完成",
  succeeded: "已成功",
  failed: "失败",
  draft: "草稿",
  published: "已发布",
  retired: "已退役",
  archived: "已归档",
  expired: "已过期",
};

const sourceLabels: Record<string, string> = {
  governance: "治理配置",
  legacy_projection: "历史投影",
  platform_default: "平台默认",
  platform_override: "平台单独配置",
  plan: "套餐配置",
  plan_default: "套餐默认",
  legacy_migrated: "历史迁移",
  system: "系统",
};

const effectiveModeLabels: Record<string, string> = {
  immediate: "立即生效",
  source_immediate: "源数据立即生效",
  source_immediate_projection_pending: "源数据立即生效，投影异步更新",
  projection_pending: "等待投影生效",
};

const resourceTypeLabels: Record<string, string> = {
  agent: "智能体",
  agent_template: "智能体模板",
  model: "模型",
  skill: "技能",
  connector: "连接器",
  environment: "环境",
  environment_template: "环境模板",
  tool: "工具",
};

function localizedValue(value: string | null | undefined, labels: Record<string, string>) {
  if (!value) return "—";
  return labels[value] ?? `未知（${value}）`;
}

function Empty({ children }: { children: string }) {
  return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function Header({ title, description }: { title: string; description: string }) {
  return <div className="mb-5"><h2 className="text-xl font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>;
}

function Receipt({ value }: { value: GovernanceReceipt }) {
  return <div className="space-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-xs"><div className="font-medium">变更回执</div><div>changeId：{value.changeId}</div><div>auditId：{value.auditId}{value.auditCompletion === "pending" ? "（终态审计排队中）" : ""}</div><div>生效时间：{new Date(value.effectiveAt).toLocaleString()}</div>{value.projectionStatus ? <div>投影：{localizedValue(value.projectionStatus, statusLabels)}{value.projectionId ? ` · ${value.projectionId}` : ""}</div> : null}</div>;
}

function TenantLifecyclePanel({ tenantId }: { tenantId: string }) {
  const request = useMemo(() => () => governanceAccessApi.getTenantLifecycle<TenantLifecycleResponse>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `tenant-lifecycle:${tenantId}`);
  const [preview, setPreview] = useState<TenantLifecyclePreview | null>(null);
  const [receipt, setReceipt] = useState<GovernanceReceipt | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  if (loading) return <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">正在读取生命周期…</div>;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  if (!data) return <Empty>组织生命周期数据不可用。</Empty>;
  const action = data.allowedActions[0];
  const runPreview = async () => {
    if (!action) return;
    setBusy(true); setMutationError(""); setReceipt(null);
    try { setPreview(await governanceAccessApi.previewTenantLifecycle<TenantLifecyclePreview>(tenantId, { action: action.action, reason })); }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!action || !preview) return;
    setBusy(true); setMutationError("");
    try {
      const result = await governanceAccessApi.updateTenantLifecycle<GovernanceReceipt>(tenantId, {
        action: action.action, reason, previewId: preview.previewId,
        baselineDigest: preview.baselineDigest, expiresAt: preview.expiresAt,
      });
      setReceipt(result); setPreview(null); retry();
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-3"><Fact label="状态" value={localizedValue(data.status, statusLabels)} /><Fact label="更新时间" value={new Date(data.updatedAt).toLocaleString()} /><Fact label="组织 ID" value={data.tenantId} /></div>
    {action ? <Input value={reason} onChange={event => { setReason(event.target.value); setPreview(null); setReceipt(null); }} placeholder="填写操作原因" /> : null}
    {mutationError ? <div className="rounded-xl border border-destructive/30 p-3 text-sm text-destructive">{mutationError}</div> : null}
    {receipt ? <Receipt value={receipt} /> : null}
    {preview ? <div className="rounded-xl border bg-card p-4"><div className="text-sm">{localizedValue(preview.impact.from, statusLabels)} → {localizedValue(preview.impact.to, statusLabels)} · {preview.impact.reversible ? "可逆" : "不可逆"}</div><div className="mt-1 text-xs text-muted-foreground">生效方式：{localizedValue(preview.impact.effectiveMode, effectiveModeLabels)} · 基线 {preview.baselineDigest.slice(0, 12)}… · 有效期至 {new Date(preview.expiresAt).toLocaleString()}</div>{preview.impact.blockers.length ? <div className="mt-2 rounded border border-destructive/30 p-2 text-xs text-destructive">阻断：{preview.impact.blockers.join("、")}</div> : null}<Button className="mt-3" disabled={busy || preview.impact.blockers.length > 0 || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void commit()}>确认执行</Button></div> : action ? <Button disabled={busy || reason.trim().length < 3} onClick={() => void runPreview()}>{action.label}</Button> : <Empty>后端未返回可执行动作。</Empty>}
  </div>;
}

function EntitlementActions({ tenantId, entitlement, actions, onChanged }: {
  tenantId: string;
  entitlement: EntitlementRecord;
  actions: EntitlementResponse['allowedActions'];
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<EntitlementPreview | null>(null);
  const [receipt, setReceipt] = useState<GovernanceReceipt | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action = actions[0];
  if (!action) return <ReadOnlyReason />;
  const change = { expectedVersion: entitlement.version, ...action.change, reason };
  const runPreview = async () => {
    setBusy(true); setError(""); setReceipt(null);
    try { setPreview(await governanceAccessApi.previewEntitlements<EntitlementPreview>(change, tenantId)); }
    catch { setError("权益预览失败，请刷新权威基线后重试。"); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await governanceAccessApi.updateEntitlements<GovernanceReceipt>({
        ...change, previewId: preview.previewId,
        baselineDigest: preview.baselineDigest, expiresAt: preview.expiresAt,
      }, tenantId);
      setReceipt(result); setPreview(null); onChanged();
    } catch { setPreview(null); setError("权益提交失败，预览可能已过期或基线已变化。"); }
    finally { setBusy(false); }
  };
  return <div className="mt-4 space-y-3">
    <Input value={reason} onChange={event => { setReason(event.target.value); setPreview(null); setReceipt(null); }} placeholder="填写权益变更原因" />
    {error ? <div role="alert" className="text-sm text-destructive">{error}</div> : null}
    {receipt ? <Receipt value={receipt} /> : null}
    {preview
      ? <div className="space-y-1 rounded-xl border p-4 text-sm"><div>影响预览：v{preview.impact.currentVersion} → v{preview.impact.nextVersion}</div><div>{localizedValue(preview.impact.fromStatus, statusLabels)} → {localizedValue(preview.impact.toStatus, statusLabels)} · {preview.impact.reversible ? "可逆" : "不可逆"}</div><div className="text-xs text-muted-foreground">生效方式：{localizedValue(preview.impact.effectiveMode, effectiveModeLabels)} · 基线 {preview.baselineDigest.slice(0, 12)}… · 有效期至 {new Date(preview.expiresAt).toLocaleString()}</div>{preview.impact.blockers.length ? <div className="rounded border border-destructive/30 p-2 text-xs text-destructive">阻断：{preview.impact.blockers.join("、")}</div> : null}<Button className="mt-3" disabled={busy || preview.impact.blockers.length > 0 || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void commit()}>确认执行</Button></div>
      : <Button disabled={busy || reason.trim().length < 3} onClick={() => void runPreview()}>{action.label}</Button>}
  </div>;
}

function ScopeEditor({ tenantId, scope, onChanged }: { tenantId: string; scope: ResourceScope; onChanged: () => void }) {
  const [catalog, setCatalog] = useState<EntitlementResourceCatalog | null>(null);
  const [mode, setMode] = useState<ResourceScope['mode']>(scope.mode);
  const [selected, setSelected] = useState(() => new Set(scope.resourceIds));
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const [receipt, setReceipt] = useState<GovernanceReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action = scope.allowedActions.find(item => item.id === "edit_scope");
  const staleIds = catalog && mode === "selected"
    ? [...selected].filter(resourceId => !catalog.items.some(item => item.resourceId === resourceId))
    : [];
  const command = { expectedVersion: scope.version, mode, resourceIds: mode === "all" ? [] : [...selected].sort() };
  const open = async () => {
    setBusy(true); setError("");
    try { setCatalog(await governanceResourcesApi.listEntitlementResourceCatalog<EntitlementResourceCatalog>(scope.resourceType)); }
    catch { setError("权威资源目录当前不可用，已禁止编辑。"); }
    finally { setBusy(false); }
  };
  const runPreview = async () => {
    setBusy(true); setError(""); setReceipt(null);
    try { setPreview(await governanceAccessApi.previewEntitlementScope<ScopePreview>(scope.resourceType, command, tenantId)); }
    catch { setError("范围预览失败，请刷新后重试。"); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const result = await governanceAccessApi.updateEntitlementScope<GovernanceReceipt>(scope.resourceType, {
        ...command, previewId: preview.previewId, baselineDigest: preview.baselineDigest, expiresAt: preview.expiresAt,
      }, tenantId);
      setReceipt(result); setPreview(null); onChanged();
    } catch { setError("范围提交失败，可能是目录或版本已变化。"); }
    finally { setBusy(false); }
  };
  const toggle = (resourceId: string) => {
    setPreview(null); setReceipt(null);
    setSelected(current => {
      const next = new Set(current);
      if (next.has(resourceId)) next.delete(resourceId); else next.add(resourceId);
      return next;
    });
  };
  if (!action) return <ReadOnlyReason />;
  if (!catalog) return <div className="mt-3"><Button size="sm" variant="outline" disabled={busy} onClick={() => void open()}>{action.label}</Button>{error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}</div>;
  return <div className="mt-3 space-y-3 rounded-lg border p-3">
    <div className="flex gap-2"><Button size="sm" variant={mode === "all" ? "default" : "outline"} onClick={() => { setMode("all"); setPreview(null); setReceipt(null); }}>全部允许</Button><Button size="sm" variant={mode === "selected" ? "default" : "outline"} onClick={() => { setMode("selected"); setPreview(null); setReceipt(null); }}>指定资源</Button></div>
    {mode === "selected" ? <div className="space-y-2">{catalog.items.length ? catalog.items.map(item => <label key={item.resourceId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.has(item.resourceId)} onChange={() => toggle(item.resourceId)} /><span>{item.label}</span><code className="text-xs text-muted-foreground">{item.resourceId}</code></label>) : <div className="text-xs text-muted-foreground">目录暂无可分配资源。</div>}</div> : null}
    {staleIds.length ? <div role="alert" className="text-xs text-destructive">当前范围含已退出目录的资源：{staleIds.join("、")}。请先取消选择。</div> : null}
    {error ? <div role="alert" className="text-xs text-destructive">{error}</div> : null}
    {receipt ? <Receipt value={receipt} /> : null}
    {preview ? <div className="space-y-1 rounded-lg bg-muted p-3 text-xs"><div>v{preview.impact.currentVersion} → v{preview.impact.nextVersion} · {preview.impact.from.mode === "all" ? "全部允许" : "选择允许"}（{preview.impact.from.resourceCount}）→ {preview.impact.to.mode === "all" ? "全部允许" : "选择允许"}（{preview.impact.to.resourceCount}）</div><div>生效方式：{localizedValue(preview.impact.effectiveMode, effectiveModeLabels)} · {preview.impact.reversible ? "可逆" : "不可逆"} · 基线 {preview.baselineDigest.slice(0, 12)}… · 有效期至 {new Date(preview.expiresAt).toLocaleString()}</div>{preview.impact.blockers.length ? <div className="rounded border border-destructive/30 p-2 text-destructive">阻断：{preview.impact.blockers.join("、")}</div> : null}<Button className="mt-2" size="sm" disabled={busy || preview.impact.blockers.length > 0 || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void commit()}>确认提交</Button></div> : <Button size="sm" disabled={busy || staleIds.length > 0} onClick={() => void runPreview()}>预览变更</Button>}
  </div>;
}

export function PlatformOrganizationGovernance({ tenantId, route }: { tenantId: string; route: GovernanceRouteState }) {
  const request = useMemo(() => () => governanceAccessApi.getEntitlements<EntitlementResponse>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `platform-tenant:${tenantId}`);
  if (loading) return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取组织治理数据…</div>;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  const tab = route.tab ?? "overview";
  const entitlement = data?.entitlement;

  if (tab === "entitlements") return <div><Header title="权益与配额" description="展示治理权威值、来源与版本；无权威预览时不开放编辑。" />
    {!entitlement ? <Empty>该组织尚无治理 Entitlement。</Empty> : <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Fact label="状态" value={localizedValue(entitlement.status, statusLabels)} /><Fact label="来源" value={localizedValue(entitlement.source, sourceLabels)} /><Fact label="版本" value={`v${entitlement.version}`} /><Fact label="到期" value={entitlement.effectiveTo ? new Date(entitlement.effectiveTo).toLocaleString() : "未设置"} /></div>
      <div className="rounded-xl border bg-card p-4"><div className="mb-3 font-medium">硬上限</div>{Object.keys(entitlement.limits).length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(entitlement.limits).map(([key, value]) => <Fact key={key} label={key} value={String(value)} compact />)}</div> : <span className="text-sm text-muted-foreground">未配置覆盖上限</span>}</div>
    </div>}
    {entitlement ? <EntitlementActions tenantId={tenantId} entitlement={entitlement} actions={data?.allowedActions ?? []} onChanged={retry} /> : null}
  </div>;

  if (tab === "resource-scope") return <div><Header title="资源范围" description="资源目录范围只接受全部允许或从目录选择，禁止手填 ID。" />
    {!data?.scopes.length ? <Empty>该组织尚无治理资源范围记录。</Empty> : <div className="grid gap-3 md:grid-cols-2">{data.scopes.map(scope => <div key={scope.resourceType} className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between gap-3"><span className="font-medium">{localizedValue(scope.resourceType, resourceTypeLabels)}</span><Badge variant="outline">{scope.mode === "all" ? "全部允许" : `已选 ${scope.resourceIds.length}`}</Badge></div><div className="mt-2 text-xs text-muted-foreground">{localizedValue(scope.source, sourceLabels)} · v{scope.version}</div>{scope.mode === "selected" && <div className="mt-3 break-all text-xs">{scope.resourceIds.join("、") || "没有已选资源"}</div>}<ScopeEditor tenantId={tenantId} scope={scope} onChanged={retry} /></div>)}</div>}
  </div>;

  if (tab === "billing") return <div><Header title="计费" description="只呈现已有真实商业字段，不虚构订单、续费或自动降级状态机。" /><Empty>计费明细继续使用现有平台计费页面；本组织详情尚未提供统一计费聚合 DTO。</Empty></div>;
  if (tab === "security-lifecycle") return <div><Header title="安全与生命周期" description="组织暂停与恢复执行预览→基线校验→审计回执；删除继续走持久化变更任务。" /><TenantLifecyclePanel tenantId={tenantId} /></div>;
  return <div><Header title="组织治理概览" description="组织权益、资源范围和策略均来自治理事实源。" />
    <div className="grid gap-3 sm:grid-cols-3"><Fact label="权益状态" value={entitlement ? localizedValue(entitlement.status, statusLabels) : "未配置"} /><Fact label="资源范围" value={`${data?.scopes.length ?? 0} 类`} /><Fact label="组织策略" value={`${data?.policies.length ?? 0} 项`} /></div>
    <div className="mt-4 flex items-start gap-2 rounded-xl border bg-card p-4 text-sm"><EntityIcons.admin className="mt-0.5 size-4 shrink-0" /><span>本页读取新治理事实源，不再用旧 TenantSettings 推导权限。</span></div>
  </div>;
}

function Fact({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return <div className={compact ? "rounded-lg bg-muted/40 p-3" : "rounded-xl border bg-card p-4"}><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{value}</div></div>;
}
function ReadOnlyReason() {
  return <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>后端未返回可执行动作；本页保持只读，不会在前端推导权限。</span></div>;
}

export function PlatformAdminsPage() {
  const request = useMemo(() => () => governanceAccessApi.listPlatformAdmins<PlatformAdminResponse>(), []);
  const { data, loading, error, retry } = useGovernanceRequest(request, "platform-admins");
  if (loading) return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取平台管理员…</div>;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  return <div><Header title="平台管理员" description="该身份拥有完整平台控制面权限，不再展示失效的能力矩阵。" />
    {!data?.platformAdmins.length ? <Empty>没有可展示的平台管理员记录。</Empty> : <div className="overflow-x-auto rounded-xl border bg-card" tabIndex={0}><table className="min-w-[680px] w-full text-sm"><thead className="bg-muted/50 text-left text-muted-foreground"><tr><th className="px-4 py-3">平台管理员</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">来源</th><th className="px-4 py-3">版本</th></tr></thead><tbody className="divide-y">{data.platformAdmins.map(item => <tr key={item.userId}><td className="px-4 py-3"><div className="font-medium">{item.directoryProfile?.displayName ?? "目录资料不可用"}</div><div className="text-xs text-muted-foreground">{item.directoryProfile?.username ?? "账号未知"} · <span className="font-mono">{item.userId}</span></div></td><td className="px-4 py-3"><Badge variant={item.status === "active" ? "secondary" : "outline"}>{localizedValue(item.status, statusLabels)}</Badge></td><td className="px-4 py-3">{localizedValue(item.source, sourceLabels)}</td><td className="px-4 py-3">v{item.version}</td></tr>)}</tbody></table></div>}
    <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">新增、移除与恢复尚未绑定统一影响预览，因此本页保持只读。</div>
  </div>;
}

export function PlatformTemplateCatalogPage({ kind }: { kind: "agent" | "environment" }) {
  const request = useMemo(() => async () => {
    if (kind === "agent") {
      const response = await governanceResourcesApi.listAgentTemplates<{ agents: Array<{ agentId: string; status: string; revision: number; tenantId: string }> }>();
      return { items: response.agents.map(item => ({ id: item.agentId, name: item.agentId, status: item.status, version: item.revision, scope: item.tenantId })) };
    }
    const response = await governanceResourcesApi.listEnvironmentTemplates<{ templates: Array<{ templateId: string; name: string; status: string; revision: number }> }>();
    return { items: response.templates.map(item => ({ id: item.templateId, name: item.name, status: item.status, version: item.revision, scope: "platform" })) };
  }, [kind]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `platform-template-catalog:${kind}`);
  if (loading) return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取模板目录…</div>;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  const items = data?.items ?? [];
  return <div><Header title={kind === "agent" ? "智能体模板" : "环境模板"} description="模板目录来自稳定资源与版本事实源；不使用展示字典或旧配置拼装。" />{items.length ? <div className="overflow-x-auto rounded-xl border bg-card" tabIndex={0}><table className="min-w-[680px] w-full text-sm"><thead className="bg-muted/50 text-left text-muted-foreground"><tr><th className="px-4 py-3">模板</th><th className="px-4 py-3">稳定 ID</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">范围</th><th className="px-4 py-3">版本</th></tr></thead><tbody className="divide-y">{items.map(item => <tr key={item.id}><td className="px-4 py-3">{item.name}</td><td className="px-4 py-3 font-mono text-xs">{item.id}</td><td className="px-4 py-3"><Badge variant="outline">{localizedValue(item.status, statusLabels)}</Badge></td><td className="px-4 py-3">{item.scope === "platform" || item.scope === "pantheon" ? "平台" : item.scope}</td><td className="px-4 py-3">v{item.version}</td></tr>)}</tbody></table></div> : <Empty>当前模板目录为空。</Empty>}</div>;
}

export function PlatformGovernanceUnavailablePage({ title, reason }: { title: string; reason: string }) {
  return <div><Header title={title} description={reason} /><div className="rounded-xl border border-dashed p-8 text-center"><Boxes className="mx-auto size-7 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">后端列表或完整写入合同尚未提供；页面不会回退到错误的旧资源模型。</p></div></div>;
}
