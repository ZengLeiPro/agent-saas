import { useMemo } from "react";
import { Boxes, TriangleAlert } from "lucide-react";

import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { Badge } from "@/components/ui/badge";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import { EntityIcons } from "@/lib/icons";
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";

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
interface ResourceScope { resourceType: string; mode: "all" | "selected"; resourceIds: string[]; source: string; version: number }
interface TenantPolicy { policyKey: string; value: unknown; source: string; version: number }
interface EntitlementResponse { entitlement: EntitlementRecord | null; scopes: ResourceScope[]; policies: TenantPolicy[] }
interface PlatformAdminRecord { userId: string; status: string; source: string; version: number; createdAt?: string; updatedAt?: string }
interface PlatformAdminResponse { platformAdmins: PlatformAdminRecord[] }

function Empty({ children }: { children: string }) {
  return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function Header({ title, description }: { title: string; description: string }) {
  return <div className="mb-5"><h2 className="text-xl font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>;
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Fact label="状态" value={entitlement.status} /><Fact label="来源" value={entitlement.source} /><Fact label="版本" value={`v${entitlement.version}`} /><Fact label="到期" value={entitlement.effectiveTo ? new Date(entitlement.effectiveTo).toLocaleString() : "未设置"} /></div>
      <div className="rounded-xl border bg-card p-4"><div className="mb-3 font-medium">硬上限</div>{Object.keys(entitlement.limits).length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(entitlement.limits).map(([key, value]) => <Fact key={key} label={key} value={String(value)} compact />)}</div> : <span className="text-sm text-muted-foreground">未配置覆盖上限</span>}</div>
    </div>}
    <ReadOnlyReason />
  </div>;

  if (tab === "resource-scope") return <div><Header title="资源范围" description="资源目录范围只接受全部允许或从目录选择，禁止手填 ID。" />
    {!data?.scopes.length ? <Empty>该组织尚无治理资源范围记录。</Empty> : <div className="grid gap-3 md:grid-cols-2">{data.scopes.map(scope => <div key={scope.resourceType} className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between gap-3"><span className="font-medium">{scope.resourceType}</span><Badge variant="outline">{scope.mode === "all" ? "全部允许" : `已选 ${scope.resourceIds.length}`}</Badge></div><div className="mt-2 text-xs text-muted-foreground">{scope.source} · v{scope.version}</div>{scope.mode === "selected" && <div className="mt-3 break-all text-xs">{scope.resourceIds.join("、") || "没有已选资源"}</div>}</div>)}</div>}
    <ReadOnlyReason />
  </div>;

  if (tab === "billing") return <div><Header title="计费" description="只呈现已有真实商业字段，不虚构订单、续费或自动降级状态机。" /><Empty>计费明细继续使用现有平台计费页面；本组织详情尚未提供统一计费聚合 DTO。</Empty></div>;
  if (tab === "security-lifecycle") return <div><Header title="安全与生命周期" description="组织暂停、恢复和删除属于高影响操作。" /><Empty>统一 ChangePreview/ChangeReceipt 尚未覆盖组织生命周期，因此写操作保持关闭。</Empty></div>;
  return <div><Header title="组织治理概览" description="组织权益、资源范围和策略均来自治理事实源。" />
    <div className="grid gap-3 sm:grid-cols-3"><Fact label="权益状态" value={entitlement?.status ?? "未配置"} /><Fact label="资源范围" value={`${data?.scopes.length ?? 0} 类`} /><Fact label="组织策略" value={`${data?.policies.length ?? 0} 项`} /></div>
    <div className="mt-4 flex items-start gap-2 rounded-xl border bg-card p-4 text-sm"><EntityIcons.admin className="mt-0.5 size-4 shrink-0" /><span>本页读取新治理事实源，不再用旧 TenantSettings 推导权限。</span></div>
  </div>;
}

function Fact({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return <div className={compact ? "rounded-lg bg-muted/40 p-3" : "rounded-xl border bg-card p-4"}><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{value}</div></div>;
}
function ReadOnlyReason() {
  return <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>Entitlement/Scope 尚无统一 previewId、baseline 和审计回执，暂不开放高影响写入。</span></div>;
}

export function PlatformAdminsPage() {
  const request = useMemo(() => () => governanceAccessApi.listPlatformAdmins<PlatformAdminResponse>(), []);
  const { data, loading, error, retry } = useGovernanceRequest(request, "platform-admins");
  if (loading) return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取平台管理员…</div>;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  return <div><Header title="平台管理员" description="该身份拥有完整平台控制面权限，不再展示失效的 capability 矩阵。" />
    {!data?.platformAdmins.length ? <Empty>没有可展示的平台管理员记录。</Empty> : <div className="overflow-hidden rounded-xl border bg-card"><table className="w-full text-sm"><thead className="bg-muted/50 text-left text-muted-foreground"><tr><th className="px-4 py-3">账号 ID</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">来源</th><th className="px-4 py-3">版本</th></tr></thead><tbody className="divide-y">{data.platformAdmins.map(item => <tr key={item.userId}><td className="px-4 py-3 font-mono text-xs">{item.userId}</td><td className="px-4 py-3"><Badge variant={item.status === "active" ? "secondary" : "outline"}>{item.status}</Badge></td><td className="px-4 py-3">{item.source}</td><td className="px-4 py-3">v{item.version}</td></tr>)}</tbody></table></div>}
    <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">新增、移除与恢复尚未绑定统一影响预览，因此本页保持只读。</div>
  </div>;
}

export function PlatformGovernanceUnavailablePage({ title, reason }: { title: string; reason: string }) {
  return <div><Header title={title} description={reason} /><div className="rounded-xl border border-dashed p-8 text-center"><Boxes className="mx-auto size-7 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">后端列表或完整写入合同尚未提供；页面不会回退到错误的旧资源模型。</p></div></div>;
}
