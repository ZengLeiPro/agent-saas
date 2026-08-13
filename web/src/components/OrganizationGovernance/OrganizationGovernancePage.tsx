import { useEffect, useMemo, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { MembershipIdentityActions } from "@/components/OrganizationGovernance/MembershipIdentityActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import { governanceRoute, type GovernanceRouteState } from "@/lib/governanceNavigation";
import { navigateGovernance } from "@/lib/urlSync";
import { EntityIcons } from "@/lib/icons";
import { governanceAccessApi, governanceResourcesApi } from "@agent/shared/lib/governanceApi";

interface MembershipRecord {
  userId: string;
  persona: "platform_admin" | "org_admin" | "member";
  isOwner: boolean;
  status: string;
  version: number;
  updatedAt?: string;
  directoryProfile?: { username: string; displayName: string; accountStatus: "active" | "disabled" } | null;
  allowedActions: Array<{
    id: string;
    label: string;
    change: { persona?: "member" | "org_admin"; isOwner?: boolean; status?: "active" | "disabled" };
    requiresReason: boolean;
  }>;
}

interface MembershipResponse { memberships: MembershipRecord[] }
interface OffboardingPreviewResponse {
  previewId: string;
  idempotencyKey: string;
  baselineDigest: string;
  expiresAt: string;
  impact: {
    membership: number;
    agents: Array<{ id: string; kind: string; action: "transfer" }>;
    personalAgents: Array<{ id: string; action: "archive" }>;
    skills: Array<{ id: string; action: "retain_and_disable" }>;
    personalCredentials: Array<{ id: string; action: "revoke" }>;
    custodialCredentials: Array<{ id: string; action: "transfer_custodian" }>;
    cronOwnership: { status: string; ids?: string[] };
    activeRuns?: { status: string; ids?: string[] };
    activeSessions?: { status: string; ids?: string[] };
    oauthGrants?: { status: string; ids?: string[] };
    externalConnections?: { status: string; ids?: string[] };
    personalMemory: { status: string; ids?: string[] };
    fileOwnership: { status: string; personalFileIds?: string[]; organizationFileIds?: string[] };
  };
  blockers: Array<{ code: string; domain: string; targetId?: string }>;
  canCommit: boolean;
}
interface OffboardingJobResponse {
  job: { jobId: string; status: string; revision: number; attempt: number; createdAt: string; updatedAt: string };
  changeId?: string; auditId?: string; effectiveAt?: string; auditCompletion?: 'pending'; auditProjectionId?: string;
  domains: Array<{ domain: string; status: string; totalCount: number; completedCount: number; failedCount: number; lastErrorCode?: string; unresolvedItems?: Array<{ itemType: string; itemId: string; reasonCode: string; retryable: boolean }> }>;
  created: boolean;
}
interface DirectoryGroupsResponse {
  tenantId: string;
  groups: Array<{
    groupId: string;
    source: "dingtalk" | "governance";
    externalGroupId?: string;
    displayName: string;
    parentGroupId?: string;
    status: "active" | "disabled";
    version: number;
  }>;
}
interface MembershipDetailsResponse {
  profile: {
    userId: string; username: string; displayName: string; position?: string;
    accountStatus: "active" | "disabled"; dingtalkBound: boolean; createdAt: string; updatedAt: string;
  };
  identity: MembershipRecord;
  accessSummary: {
    effectivePersona: MembershipRecord["persona"]; owner: boolean; accountStatus: string;
    decision: "eligible" | "denied";
    why: Array<{ source: string; effect: string; version: number }>;
  };
  assignments: Array<{
    resourceType: string;
    resources: Array<{
      resourceId: string; bindingId: string; assignmentVersion: number; finalEffect: "allow";
      bindings: Array<{ assignmentId: string; assigneeType: string; assigneeId?: string; effect: string; origin: string }>;
    }>;
  }>;
  usagePolicy: {
    status?: "unavailable"; tenantId?: string; timezone?: string; periodStart?: string; periodEnd?: string;
    monthUsedCreditsMicro?: number; unattributedCreditsMicro?: number;
    items?: Array<{
      userId: string; monthlyLimitCreditsMicro?: number; enforcementMode: string; perRunLimitCreditsMicro?: number;
      active: boolean; version: number; monthUsedCreditsMicro: number; remainingCreditsMicro?: number; canStartRun: boolean;
    }>;
  };
  recentAudit: { events: Array<{ auditId: string; action: string; result: string; occurredAt: string; actorUserId: string; reason?: string }>; coverage: string; limit: number };
  snapshot: { membershipVersion: number; generatedAt: string };
}
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

const statusLabels: Record<string, string> = {
  active: "启用",
  disabled: "禁用",
  suspended: "已暂停",
  pending: "等待中",
  running: "执行中",
  completed: "已完成",
  succeeded: "已成功",
  failed: "失败",
  partial: "部分完成",
  retry_wait: "等待重试",
  clear: "无待处理项",
  blocked: "受阻",
  revoked: "已撤销",
  expired: "已过期",
  rotation_due: "待轮换",
  validation_failed: "验证失败",
};

const effectLabels: Record<string, string> = {
  allow: "允许",
  deny: "拒绝",
};

const sourceLabels: Record<string, string> = {
  membership: "成员关系",
  assignment: "资源指派",
  entitlement: "平台权益",
  policy: "组织策略",
  governance: "治理配置",
  legacy_projection: "历史投影",
  platform_default: "平台默认",
  platform_override: "平台单独配置",
  plan: "套餐配置",
  dingtalk: "钉钉",
  local: "本地",
};

function localizedValue(value: string | null | undefined, labels: Record<string, string> = statusLabels) {
  if (!value) return "—";
  return labels[value] ?? `未知（${value}）`;
}

function Loading() {
  return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取治理权威数据…</div>;
}

function SectionTitle({ title, description }: { title: string; description: string }) {
  return <div className="mb-5"><h2 className="text-xl font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>;
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{text}</div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 break-words text-sm font-medium">{value}</div></div>;
}

function OrganizationMemberDetails({ tenantId, userId, tab }: { tenantId: string; userId: string; tab: string }) {
  const request = useMemo(
    () => () => governanceAccessApi.getMembershipDetails<MembershipDetailsResponse>(userId, tenantId),
    [tenantId, userId],
  );
  const { data, loading, error, retry } = useGovernanceRequest(request, `member-details:${tenantId}:${userId}`);
  if (loading) return <Loading />;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  if (!data) return <Empty text="成员治理详情不可用。" />;
  const selected = data.identity;
  return <div className="space-y-5">
    <SectionTitle title="成员详情" description="身份和可执行动作均由后端授权；资源指派来自 Assignment 权威解析。" />
    <div className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm">{selected.userId}</span><Badge>{personaLabel[selected.persona]}</Badge>{selected.isOwner && <Badge variant="outline">所有者</Badge>}<Badge variant="secondary">{localizedValue(selected.status)}</Badge></div>
      <div className="mt-3 text-xs text-muted-foreground">成员关系 v{selected.version}{selected.updatedAt ? ` · ${new Date(selected.updatedAt).toLocaleString()}` : ""} · 快照 {new Date(data.snapshot.generatedAt).toLocaleString()}</div>
    </div>
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="成员治理详情">
      {[
        ["profile", "基本资料"], ["access", "身份与权限"], ["assignments", "资源指派"],
        ["usage-policy", "用量策略"], ["security-audit", "安全与记录"],
      ].map(([value, label]) => <Button key={value} id={`member-tab-${value}`} size="sm" role="tab" aria-selected={tab === value} aria-controls={`member-panel-${value}`} tabIndex={tab === value ? 0 : -1} variant={tab === value ? "default" : "outline"} onClick={() => navigateGovernance(governanceRoute("organization.members.member", { orgId: tenantId, entityId: userId, tab: value }))}>{label}</Button>)}
    </div>
    {tab === "profile" ? <div id="member-panel-profile" role="tabpanel" aria-labelledby="member-tab-profile" className="grid gap-3 sm:grid-cols-2"><Fact label="姓名" value={data.profile.displayName} /><Fact label="账号" value={data.profile.username} /><Fact label="岗位" value={data.profile.position ?? "未填写"} /><Fact label="账号状态" value={data.profile.accountStatus} /><Fact label="钉钉绑定" value={data.profile.dingtalkBound ? "已绑定" : "未绑定"} /><Fact label="目录更新时间" value={new Date(data.profile.updatedAt).toLocaleString()} /></div> : null}
    {tab === "access" ? <div id="member-panel-access" role="tabpanel" aria-labelledby="member-tab-access" className="space-y-3"><div className="grid gap-3 sm:grid-cols-3"><Fact label="最终身份" value={personaLabel[data.accessSummary.effectivePersona]} /><Fact label="所有者" value={data.accessSummary.owner ? "是" : "否"} /><Fact label="账号判定" value={data.accessSummary.decision === "eligible" ? "可参与权限解析" : "已拒绝"} /></div><div className="rounded-xl border bg-card p-4"><div className="font-medium">为什么</div><ul className="mt-2 divide-y text-sm">{data.accessSummary.why.map((item, index) => <li key={`${item.source}-${index}`} className="flex justify-between gap-3 py-2"><span>{localizedValue(item.source, sourceLabels)}</span><span className="text-muted-foreground">{localizedValue(item.effect, effectLabels)} · v{item.version}</span></li>)}</ul></div></div> : null}
    {tab === "assignments" ? <div id="member-panel-assignments" role="tabpanel" aria-labelledby="member-tab-assignments" className="grid gap-3 md:grid-cols-2">{data.assignments.map(group => <div key={group.resourceType} className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between gap-3"><span className="font-medium">{group.resourceType}</span><Badge variant="outline">{group.resources.length} 项</Badge></div>{group.resources.length ? <ul className="mt-3 divide-y text-xs">{group.resources.map(resource => <li key={resource.resourceId} className="py-2"><div className="flex items-center justify-between gap-2"><span className="font-mono">{resource.resourceId}</span><Badge variant="secondary">最终允许</Badge></div><div className="mt-1 text-muted-foreground">Assignment v{resource.assignmentVersion}</div><ul className="mt-2 space-y-1">{resource.bindings.map(binding => <li key={binding.assignmentId}>{binding.assigneeType}{binding.assigneeId ? `:${binding.assigneeId}` : ""} → {binding.effect}（{binding.origin}）</li>)}</ul></li>)}</ul> : <div className="mt-3 text-sm text-muted-foreground">无有效指派</div>}</div>)}</div> : null}
    {tab === "usage-policy" ? data.usagePolicy.status === "unavailable" ? <Empty text="用量策略权威暂不可用。" /> : <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-3"><Fact label="统计周期" value={`${data.usagePolicy.periodStart ?? "-"} 至 ${data.usagePolicy.periodEnd ?? "-"}`} /><Fact label="月用量" value={String(data.usagePolicy.monthUsedCreditsMicro ?? 0)} /><Fact label="未归属用量" value={String(data.usagePolicy.unattributedCreditsMicro ?? 0)} /></div>{(data.usagePolicy.items ?? []).map(item => <div key={item.userId} className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-4"><Fact label="执行模式" value={item.enforcementMode} /><Fact label="月限额" value={item.monthlyLimitCreditsMicro === undefined ? "不限制" : String(item.monthlyLimitCreditsMicro)} /><Fact label="本月已用" value={String(item.monthUsedCreditsMicro)} /><Fact label="允许启动" value={item.canStartRun ? "是" : "否"} /></div>)}</div> : null}
    {tab === "security-audit" ? <div id="member-panel-security-audit" role="tabpanel" aria-labelledby="member-tab-security-audit" className="space-y-3"><div className="text-xs text-muted-foreground">覆盖范围：最近 {data.recentAudit.limit} 条组织治理审计中的 Membership 端点事件</div>{data.recentAudit.events.length ? data.recentAudit.events.map(event => <div key={event.auditId} className="rounded-xl border bg-card p-4 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{event.action}</span><Badge variant="outline">{event.result}</Badge></div><div className="mt-2 text-xs text-muted-foreground">{new Date(event.occurredAt).toLocaleString()} · 操作人 {event.actorUserId}</div>{event.reason ? <div className="mt-2">原因：{event.reason}</div> : null}</div>) : <Empty text="当前覆盖窗口内没有成员治理记录。" />}</div> : null}
  </div>;
}

export function OrganizationMembersPage({ tenantId, route }: { tenantId: string; route: GovernanceRouteState }) {
  const request = useMemo(() => () => governanceAccessApi.listMemberships<MembershipResponse>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `members:${tenantId}`);
  if (loading) return <Loading />;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  const memberships = data?.memberships ?? [];

  if (route.routeId === "organization.members.member") {
    if (!route.entityId) return <Empty text="成员详情缺少不可变 userId。" />;
    return <OrganizationMemberDetails tenantId={tenantId} userId={route.entityId} tab={route.tab ?? "profile"} />;
  }

  return <div>
    <SectionTitle title={route.routeId === "organization.members.owners" ? "组织所有者与管理员" : "成员与权限"} description="治理身份、所有者标记和状态来自成员关系权威数据。" />
    {memberships.length === 0 ? <Empty text="当前组织没有可展示的治理成员关系。" /> : (
      <div className="overflow-x-auto rounded-xl border bg-card" tabIndex={0} aria-label="成员治理列表，可横向滚动">
        <table className="min-w-[900px] w-full text-sm"><thead className="bg-muted/50 text-left text-muted-foreground"><tr><th className="px-4 py-3">成员</th><th className="px-4 py-3">身份</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">版本</th><th className="px-4 py-3">身份治理</th><th className="px-4 py-3">详情</th></tr></thead>
          <tbody className="divide-y">{memberships.filter(item => route.routeId !== "organization.members.owners" || item.persona === "org_admin").map(item => <tr key={item.userId}><td className="px-4 py-3"><div className="font-medium">{item.directoryProfile?.displayName ?? "目录资料不可用"}</div><div className="text-xs text-muted-foreground">{item.directoryProfile?.username ?? "账号未知"} · <span className="font-mono">{item.userId}</span></div></td><td className="px-4 py-3"><span className="inline-flex items-center gap-2">{personaLabel[item.persona]}{item.isOwner && <Badge variant="outline">所有者</Badge>}</span></td><td className="px-4 py-3"><Badge variant={item.status === "active" ? "secondary" : "outline"}>{localizedValue(item.status)}</Badge></td><td className="px-4 py-3">v{item.version}</td><td className="px-4 py-3"><MembershipIdentityActions tenantId={tenantId} target={item} onChanged={retry} /></td><td className="px-4 py-3"><Button size="sm" variant="outline" onClick={() => navigateGovernance(governanceRoute("organization.members.member", { orgId: tenantId, entityId: item.userId, tab: "profile" }))}>打开详情</Button></td></tr>)}</tbody>
        </table>
      </div>
    )}
    <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>仅 所有者可以管理其他管理员；每次变更都先取得版本绑定的后端预览，最后一名所有者由事务不变量保护。</span></div>
  </div>;
}

export function OrganizationGroupsPage({ tenantId }: { tenantId: string }) {
  const request = useMemo(() => () => governanceAccessApi.listDirectoryGroups<DirectoryGroupsResponse>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `directory-groups:${tenantId}`);
  if (loading) return <Loading />;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  const groups = data?.groups ?? [];
  return <div>
    <SectionTitle title="部门与群组" description="本地不可变群组 ID 承载治理绑定；外部目录 ID 仅作同步映射。" />
    {groups.length ? <div className="overflow-x-auto rounded-xl border bg-card" tabIndex={0} aria-label="目录群组列表，可横向滚动"><table className="min-w-[720px] w-full text-sm"><thead className="bg-muted/50 text-left text-muted-foreground"><tr><th className="px-4 py-3">群组</th><th className="px-4 py-3">本地群组 ID</th><th className="px-4 py-3">来源</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">版本</th></tr></thead><tbody className="divide-y">{groups.map(group => <tr key={group.groupId}><td className="px-4 py-3">{group.displayName}</td><td className="px-4 py-3 font-mono text-xs">{group.groupId}</td><td className="px-4 py-3">{localizedValue(group.source, sourceLabels)}</td><td className="px-4 py-3"><Badge variant={group.status === "active" ? "secondary" : "outline"}>{localizedValue(group.status)}</Badge></td><td className="px-4 py-3">v{group.version}</td></tr>)}</tbody></table></div> : <Empty text="目录权威服务已接入，但当前组织尚无同步群组。" />}
    <div className="mt-4 rounded-xl border p-3 text-sm text-muted-foreground">群组成员由目录投影维护，本页只读；不会把个人会话分组当作组织目录群组。</div>
  </div>;
}

export function OrganizationOffboardingPage({ tenantId }: { tenantId: string }) {
  const membershipRequest = useMemo(() => () => governanceAccessApi.listMemberships<MembershipResponse>(tenantId), [tenantId]);
  const membershipDirectory = useGovernanceRequest(membershipRequest, `offboarding-members:${tenantId}`);
  const [userId, setUserId] = useState("");
  const [handoffTargetUserId, setHandoffTargetUserId] = useState("");
  const [reasonCode, setReasonCode] = useState("employee_departure");
  const [preview, setPreview] = useState<OffboardingPreviewResponse | null>(null);
  const [result, setResult] = useState<OffboardingJobResponse | null>(null);
  const [receipt, setReceipt] = useState<Pick<OffboardingJobResponse, 'changeId' | 'auditId' | 'effectiveAt' | 'auditCompletion' | 'auditProjectionId'> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const command = { tenantId, userId, handoffTargetUserId, reasonCode };
  const resetPreview = () => { setPreview(null); setResult(null); setReceipt(null); setError(""); };
  const runPreview = async () => {
    setBusy(true); setError(""); setResult(null);
    try { setPreview(await governanceResourcesApi.previewUserOffboarding<OffboardingPreviewResponse>(command)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview?.canCommit) return;
    setBusy(true); setError("");
    try {
      const started = await governanceResourcesApi.startUserOffboarding<OffboardingJobResponse>({
        ...command,
        idempotencyKey: preview.idempotencyKey,
        previewId: preview.previewId,
        baselineDigest: preview.baselineDigest,
        expiresAt: preview.expiresAt,
      });
      setReceipt(started);
      setResult(started);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!result || ["succeeded", "partial", "failed"].includes(result.job.status)) return;
    const timer = window.setTimeout(() => {
      void governanceResourcesApi.getChangeJob<OffboardingJobResponse>(result.job.jobId, tenantId)
        .then(setResult)
        .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [result, tenantId]);
  const retryJob = async () => {
    if (!result) return;
    setBusy(true); setError("");
    try {
      setResult(await governanceResourcesApi.retryChangeJob<OffboardingJobResponse>(result.job.jobId, result.job.revision, tenantId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  if (membershipDirectory.loading) return <Loading />;
  if (membershipDirectory.error) return <GovernanceUnavailable error={membershipDirectory.error} onRetry={membershipDirectory.retry} />;
  const activeMembers = (membershipDirectory.data?.memberships ?? []).filter(item => item.status === "active");
  return <div className="space-y-5">
    <SectionTitle title="离职撤权与资源交接" description="先冻结版本化影响快照；存在未交接项时后端拒绝提交，不执行半截删除。" />
    <div className="grid gap-3 rounded-xl border bg-card p-5 md:grid-cols-3">
      <label className="space-y-1 text-sm"><span>离职成员</span><select className="h-9 w-full rounded-md border bg-background px-3" value={userId} onChange={event => { setUserId(event.target.value); resetPreview(); }}><option value="">请选择有效成员</option>{activeMembers.map(item => <option key={item.userId} value={item.userId}>{item.directoryProfile?.displayName ?? item.directoryProfile?.username ?? item.userId} · {personaLabel[item.persona]} · {localizedValue(item.directoryProfile?.accountStatus ?? item.status)}</option>)}</select></label>
      <label className="space-y-1 text-sm"><span>接手成员</span><select className="h-9 w-full rounded-md border bg-background px-3" value={handoffTargetUserId} onChange={event => { setHandoffTargetUserId(event.target.value); resetPreview(); }}><option value="">请选择有效成员</option>{activeMembers.filter(item => item.userId !== userId).map(item => <option key={item.userId} value={item.userId}>{item.directoryProfile?.displayName ?? item.directoryProfile?.username ?? item.userId} · {personaLabel[item.persona]} · {localizedValue(item.directoryProfile?.accountStatus ?? item.status)}</option>)}</select></label>
      <label className="space-y-1 text-sm"><span>原因代码</span><select className="h-9 w-full rounded-md border bg-background px-3" value={reasonCode} onChange={event => { setReasonCode(event.target.value); resetPreview(); }}><option value="employee_departure">员工离职</option><option value="contract_ended">合同终止</option><option value="account_consolidation">账号合并</option></select></label>
      <div className="md:col-span-3"><Button disabled={busy || !userId || !handoffTargetUserId || userId === handoffTargetUserId} onClick={() => void runPreview()}>生成影响预览</Button></div>
    </div>
    {error ? <div role="alert" className="rounded-xl border border-destructive/40 p-3 text-sm text-destructive">{error}</div> : null}
    {preview ? <div className="space-y-3 rounded-xl border bg-card p-5"><div className="flex items-center justify-between gap-3"><span className="font-medium">权威影响快照</span><Badge variant={preview.canCommit ? "secondary" : "destructive"}>{preview.canCommit ? "可提交" : `${preview.blockers.length} 个阻断`}</Badge></div><div className="grid gap-3 sm:grid-cols-3"><Fact label="组织智能体交接" value={`${preview.impact.agents.length} 项`} /><Fact label="个人智能体归档" value={`${preview.impact.personalAgents.length} 项`} /><Fact label="个人技能停用保留" value={`${preview.impact.skills.length} 项`} /><Fact label="个人凭据撤销" value={`${preview.impact.personalCredentials.length} 项`} /><Fact label="凭据托管人转移" value={`${preview.impact.custodialCredentials.length} 项`} /><Fact label="定时任务" value={localizedValue(preview.impact.cronOwnership.status)} /><Fact label="个人记忆" value={localizedValue(preview.impact.personalMemory.status)} /><Fact label="文件归属" value={localizedValue(preview.impact.fileOwnership.status)} /><Fact label="活跃运行" value={`${preview.impact.activeRuns?.ids?.length ?? 0} 项`} /><Fact label="会话留存" value={`${preview.impact.activeSessions?.ids?.length ?? 0} 项`} /><Fact label="OAuth 授权" value={`${preview.impact.oauthGrants?.ids?.length ?? 0} 项`} /><Fact label="外部连接" value={`${preview.impact.externalConnections?.ids?.length ?? 0} 项`} /></div><div className="text-xs text-muted-foreground">基线 {preview.baselineDigest.slice(0, 12)}… · 签名预览有效期至 {new Date(preview.expiresAt).toLocaleString()}</div>{preview.blockers.length ? <ul className="space-y-1 rounded-xl border border-destructive/30 p-3 text-sm text-destructive">{preview.blockers.map(item => <li key={`${item.code}:${item.targetId ?? item.domain}`}>{item.domain} · {item.code}{item.targetId ? ` · ${item.targetId}` : ""}</li>)}</ul> : <Button disabled={busy || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void commit()}>确认交接并撤权</Button>}</div> : null}
    {result ? <div className="space-y-3 rounded-xl border p-4 text-sm">{receipt ? <div role="status" aria-live="polite" className="rounded-lg border bg-muted/30 p-3 text-xs"><div className="font-medium">治理回执</div><div>Change ID：{receipt.changeId ?? "未返回"} · Audit ID：{receipt.auditId ?? "未返回"}</div><div>{receipt.effectiveAt ? `生效于 ${new Date(receipt.effectiveAt).toLocaleString()}` : receipt.auditCompletion === "pending" ? `终态审计待投影${receipt.auditProjectionId ? ` · ${receipt.auditProjectionId}` : ""}` : "生效时间未返回"}</div></div> : null}<div className="flex flex-wrap items-center gap-2"><span>变更任务</span><strong>{localizedValue(result.job.status)}</strong><span className="font-mono text-xs">{result.job.jobId}</span><Badge variant="outline">尝试次数 {result.job.attempt}</Badge></div><div className="grid gap-2 md:grid-cols-2">{result.domains.map(domain => <div key={domain.domain} className="rounded-lg border p-3"><div className="flex items-center justify-between gap-2"><span className="font-medium">{domain.domain}</span><Badge variant={domain.status === "completed" ? "secondary" : "outline"}>{localizedValue(domain.status)}</Badge></div><div className="mt-1 text-xs text-muted-foreground">完成 {domain.completedCount}/{domain.totalCount} · 失败 {domain.failedCount}{domain.lastErrorCode ? ` · ${domain.lastErrorCode}` : ""}</div>{domain.unresolvedItems?.length ? <ul className="mt-2 space-y-1 text-xs text-destructive">{domain.unresolvedItems.map(item => <li key={`${item.itemType}:${item.itemId}`}>{item.itemType} · {item.itemId} · {item.reasonCode}{item.retryable ? "（可重试）" : ""}</li>)}</ul> : null}</div>)}</div>{["retry_wait", "partial", "failed"].includes(result.job.status) ? <Button variant="outline" disabled={busy} onClick={() => void retryJob()}>重试未完成域</Button> : null}</div> : null}
  </div>;
}

export function OrganizationPoliciesPage({ tenantId }: { tenantId: string }) {
  const request = useMemo(() => () => governanceAccessApi.getEntitlements<EntitlementResponse>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `policies:${tenantId}`);
  if (loading) return <Loading />;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  return <div><SectionTitle title="权限策略" description="平台权益只读，组织策略按业务对象展示；本页不使用统一总开关。" />
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border bg-card p-4"><div className="mb-3 font-medium">平台权益</div><div className="text-sm">状态：{data?.entitlement ? localizedValue(data.entitlement.status) : "未配置"}</div><div className="mt-1 text-xs text-muted-foreground">来源：{data?.entitlement ? localizedValue(data.entitlement.source, sourceLabels) : "—"} · v{data?.entitlement?.version ?? 0}</div></div>
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
  return <div><SectionTitle title="连接器与凭据" description="只展示别名、用途、状态和健康时间；密钥永不回显。" />
    {!data?.credentials.length ? <Empty text="当前组织没有治理凭据。" /> : <div className="grid gap-3 md:grid-cols-2">{data.credentials.map(item => <div key={item.credentialId} className="rounded-xl border bg-card p-4"><div className="flex items-start justify-between gap-3"><div><div className="font-medium">{item.alias || item.connectorId || "未命名凭据"}</div><div className="mt-1 text-xs text-muted-foreground">{item.purpose}</div></div><Badge variant={item.status === "active" ? "secondary" : "outline"}>{localizedValue(item.status)}</Badge></div><div className="mt-3 text-xs text-muted-foreground">代次 {item.generation} · v{item.version}{item.lastValidatedAt ? ` · 验证 ${new Date(item.lastValidatedAt).toLocaleString()}` : ""}</div></div>)}</div>}
    <div className="mt-4 flex items-start gap-2 rounded-xl border p-3 text-sm text-muted-foreground"><EntityIcons.admin className="mt-0.5 size-4 shrink-0" /><span>测试、轮换、责任人交接与统一创建向导尚无完整权威合同，因此未开放写操作。</span></div>
  </div>;
}

export function OrganizationGovernancePlaceholder({ title, detail }: { title: string; detail: string }) {
  return <div><SectionTitle title={title} description={detail} /><div className="rounded-xl border border-dashed bg-muted/10 p-8 text-center"><RefreshCw className="mx-auto size-6 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">权威 API 或影响预览尚未接入，本页不会展示模拟数据或虚假成功。</p></div></div>;
}
