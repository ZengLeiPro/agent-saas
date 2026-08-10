import { useMemo } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { MembershipIdentityActions } from "@/components/OrganizationGovernance/MembershipIdentityActions";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import type { GovernanceRouteState } from "@/lib/governanceNavigation";
import { EntityIcons } from "@/lib/icons";
import { governanceAccessApi, governanceResourcesApi } from "@agent/shared/lib/governanceApi";

interface MembershipRecord {
  userId: string;
  persona: "platform_admin" | "org_admin" | "member";
  isOwner: boolean;
  status: string;
  version: number;
  updatedAt?: string;
}

interface MembershipResponse { memberships: MembershipRecord[] }
interface EntitlementRecord {
  source: string;
  status: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  limits: Record<string, number>;
  version: number;
}
interface ResourceScope { resourceType: string; mode: "all" | "selected"; resourceIds: string[]; version: number }
interface TenantPolicy { policyKey: string; value: unknown; source: string; version: number }
interface EntitlementResponse { entitlement: EntitlementRecord | null; scopes: ResourceScope[]; policies: TenantPolicy[] }
interface CredentialRecord {
  credentialId: string;
  connectorId?: string;
  alias?: string;
  purpose: string;
  kind: string;
  status: string;
  generation: number;
  expiresAt?: string;
  lastValidatedAt?: string;
  version: number;
}
interface CredentialResponse { credentials: CredentialRecord[] }

const personaLabel = { platform_admin: "平台管理员", org_admin: "组织管理员", member: "成员" } as const;

function Loading() {
  return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取治理权威数据…</div>;
}

function SectionTitle({ title, description }: { title: string; description: string }) {
  return <div className="mb-5"><h2 className="text-xl font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>;
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{text}</div>;
}

export function OrganizationMembersPage({ tenantId, route }: { tenantId: string; route: GovernanceRouteState }) {
  const { user } = useAuth();
  const request = useMemo(() => () => governanceAccessApi.listMemberships<MembershipResponse>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `members:${tenantId}`);
  if (loading) return <Loading />;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  const memberships = data?.memberships ?? [];
  const actor = memberships.find(item => item.userId === user?.id);
  const selected = route.entityId ? memberships.find(item => item.userId === route.entityId) : undefined;

  if (route.routeId === "organization.members.member") {
    if (!selected) return <Empty text="未找到该成员的治理 Membership，不能回退到 legacy role 猜测身份。" />;
    const tab = route.tab ?? "profile";
    return <div className="space-y-5">
      <SectionTitle title="成员详情" description="身份来自治理 Membership；资源与权限仅展示权威接口可确认的信息。" />
      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm">{selected.userId}</span><Badge>{personaLabel[selected.persona]}</Badge>{selected.isOwner && <Badge variant="outline">Owner</Badge>}<Badge variant="secondary">{selected.status}</Badge></div>
        <div className="mt-3 text-xs text-muted-foreground">Membership v{selected.version}{selected.updatedAt ? ` · ${new Date(selected.updatedAt).toLocaleString()}` : ""}</div>
      </div>
      {tab === "profile" ? <Empty text="基本资料继续由成员目录提供；治理身份以本页 Membership 为准。" /> : null}
      {tab === "access" ? <Empty text="没有指定资源时不能生成权威权限结论。请从资源页进入“为什么”。" /> : null}
      {tab === "assignments" ? <Empty text="成员聚合 Assignment API 尚未提供；本页不会枚举或猜测资源指派。" /> : null}
      {tab === "usage-policy" ? <Empty text="成员级用量策略聚合接口尚未提供。" /> : null}
      {tab === "security-audit" ? <Empty text="治理审计查询接口尚未提供；登录活动不能冒充治理审计。" /> : null}
    </div>;
  }

  return <div>
    <SectionTitle title={route.routeId === "organization.members.owners" ? "组织 Owner 与管理员" : "成员与权限"} description="治理身份、Owner 标记和状态来自 Membership 权威数据。" />
    {memberships.length === 0 ? <Empty text="当前组织没有可展示的治理 Membership。" /> : (
      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm"><thead className="bg-muted/50 text-left text-muted-foreground"><tr><th className="px-4 py-3">成员</th><th className="px-4 py-3">身份</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">版本</th><th className="px-4 py-3">身份治理</th></tr></thead>
          <tbody className="divide-y">{memberships.filter(item => route.routeId !== "organization.members.owners" || item.persona === "org_admin").map(item => <tr key={item.userId}><td className="px-4 py-3 font-mono text-xs">{item.userId}</td><td className="px-4 py-3"><span className="inline-flex items-center gap-2">{personaLabel[item.persona]}{item.isOwner && <Badge variant="outline">Owner</Badge>}</span></td><td className="px-4 py-3"><Badge variant={item.status === "active" ? "secondary" : "outline"}>{item.status}</Badge></td><td className="px-4 py-3">v{item.version}</td><td className="px-4 py-3"><MembershipIdentityActions tenantId={tenantId} actor={actor} target={item} onChanged={retry} /></td></tr>)}</tbody>
        </table>
      </div>
    )}
    <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>仅 Owner 可以管理其他管理员；每次变更都先取得版本绑定的后端 preview，最后一名 Owner 由事务不变量保护。</span></div>
  </div>;
}

export function OrganizationPoliciesPage({ tenantId }: { tenantId: string }) {
  const request = useMemo(() => () => governanceAccessApi.getEntitlements<EntitlementResponse>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `policies:${tenantId}`);
  if (loading) return <Loading />;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  return <div><SectionTitle title="权限策略" description="平台权益只读，组织策略按业务对象展示；本页不使用统一总开关。" />
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border bg-card p-4"><div className="mb-3 font-medium">平台权益</div><div className="text-sm">状态：{data?.entitlement?.status ?? "未配置"}</div><div className="mt-1 text-xs text-muted-foreground">来源：{data?.entitlement?.source ?? "—"} · v{data?.entitlement?.version ?? 0}</div></div>
      <div className="rounded-xl border bg-card p-4"><div className="mb-3 font-medium">组织策略</div>{data?.policies.length ? <ul className="divide-y text-sm">{data.policies.map(policy => <li key={policy.policyKey} className="flex items-center justify-between gap-3 py-2"><span className="font-mono text-xs">{policy.policyKey}</span><span>{typeof policy.value === "boolean" ? (policy.value ? "允许" : "禁止") : "已配置"}</span></li>)}</ul> : <span className="text-sm text-muted-foreground">没有治理策略记录</span>}</div>
    </div>
    <div className="mt-4 rounded-xl border p-3 text-sm text-muted-foreground">策略写入尚未具备统一影响预览与回执，本页暂时只读。</div>
  </div>;
}

export function OrganizationCredentialsPage({ tenantId }: { tenantId: string }) {
  const request = useMemo(() => () => governanceResourcesApi.listCredentials<CredentialResponse>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `credentials:${tenantId}`);
  if (loading) return <Loading />;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  return <div><SectionTitle title="Connector 与 Credential" description="只展示别名、用途、状态和健康时间；Secret 永不回显。" />
    {!data?.credentials.length ? <Empty text="当前组织没有治理 Credential。" /> : <div className="grid gap-3 md:grid-cols-2">{data.credentials.map(item => <div key={item.credentialId} className="rounded-xl border bg-card p-4"><div className="flex items-start justify-between gap-3"><div><div className="font-medium">{item.alias || item.connectorId || "未命名 Credential"}</div><div className="mt-1 text-xs text-muted-foreground">{item.purpose}</div></div><Badge variant={item.status === "active" ? "secondary" : "outline"}>{item.status}</Badge></div><div className="mt-3 text-xs text-muted-foreground">generation {item.generation} · v{item.version}{item.lastValidatedAt ? ` · 验证 ${new Date(item.lastValidatedAt).toLocaleString()}` : ""}</div></div>)}</div>}
    <div className="mt-4 flex items-start gap-2 rounded-xl border p-3 text-sm text-muted-foreground"><EntityIcons.admin className="mt-0.5 size-4 shrink-0" /><span>测试、轮换、责任人交接与统一创建向导尚无完整权威合同，因此未开放写操作。</span></div>
  </div>;
}

export function OrganizationGovernancePlaceholder({ title, detail }: { title: string; detail: string }) {
  return <div><SectionTitle title={title} description={detail} /><div className="rounded-xl border border-dashed bg-muted/10 p-8 text-center"><RefreshCw className="mx-auto size-6 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">权威 API 或影响预览尚未接入，本页不会展示模拟数据或虚假成功。</p></div></div>;
}
