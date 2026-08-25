import { useMemo, useState } from "react";

import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import { authFetch } from "@/lib/authFetch";
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";

import { KnowledgeSuiteSetup, type BatchReceipt, type KnowledgeSuite } from "./KnowledgeSuiteSetup";

type AssigneeType = "everyone" | "user" | "directory_group" | "agent";
type Effect = "allow" | "deny";
interface AssignmentRule {
  assigneeType: AssigneeType;
  assigneeId?: string;
  effect: Effect;
  origin?: "direct" | "migration" | "policy_default";
}
interface OrganizationResourceRecord {
  resourceId: string;
  name: string;
  status: "enabled" | "disabled";
  policyEnabled: boolean;
  scope?: AssignmentRule[];
  effectiveAssignment?: "assigned";
  source: string;
  version: number;
  updatedAt: string;
}
interface Response {
  tenantId: string;
  authority: "governance_assignment_sets";
  accessMode: "manage" | "inspect" | "effective_only";
  suites: KnowledgeSuite[];
  knowledge: OrganizationResourceRecord[];
  memory: OrganizationResourceRecord[];
  effective: { organizationKnowledge: boolean; organizationMemory: boolean };
}
interface Preview { previewId: string; baselineDigest: string; expiresAt: string; impact: Record<string, unknown>; changeId: string }
interface Receipt { changeId: string; auditId: string; effectiveAt?: string; version?: number }
interface SubjectCatalog {
  users: Array<{ userId: string; label: string }>;
  groups: Array<{ groupId: string; displayName: string }>;
  agents: Array<{ id: string; name: string }>;
}

function ReceiptView({ receipt }: { receipt: Receipt | null }) {
  if (!receipt) return null;
  return <div className="mt-2 rounded border bg-muted/20 p-2 text-xs">changeId：{receipt.changeId}<br />auditId：{receipt.auditId}{receipt.effectiveAt ? <><br />生效：{new Date(receipt.effectiveAt).toLocaleString()}</> : null}</div>;
}

function optionValues(type: AssigneeType, catalog: SubjectCatalog | null): Array<{ id: string; label: string }> {
  if (!catalog) return [];
  if (type === "user") return catalog.users.map(item => ({ id: item.userId, label: item.label }));
  if (type === "directory_group") return catalog.groups.map(item => ({ id: item.groupId, label: item.displayName }));
  if (type === "agent") return catalog.agents.map(item => ({ id: item.id, label: item.name }));
  return [];
}

function RuleEditor({ resourceId, rules, catalog, onChange }: {
  resourceId: string;
  rules: AssignmentRule[];
  catalog: SubjectCatalog | null;
  onChange: (rules: AssignmentRule[]) => void;
}) {
  const update = (index: number, next: AssignmentRule) => onChange(rules.map((rule, i) => i === index ? next : rule));
  return <div className="space-y-2">
    {rules.length ? rules.map((rule, index) => {
      const options = optionValues(rule.assigneeType, catalog);
      const hasCurrent = !rule.assigneeId || options.some(option => option.id === rule.assigneeId);
      return <div key={`${index}:${rule.assigneeType}:${rule.assigneeId ?? "everyone"}`} className="grid gap-2 rounded-lg border p-2 md:grid-cols-[150px_130px_minmax(180px,1fr)_auto]">
        <select aria-label={`${resourceId}规则${index + 1}主体类型`} className="rounded-md border bg-background px-2 py-2 text-sm" value={rule.assigneeType} onChange={event => update(index, { assigneeType: event.target.value as AssigneeType, effect: rule.effect })}>
          <option value="everyone">所有有效成员</option><option value="user">成员</option><option value="directory_group">目录群组</option><option value="agent">Agent</option>
        </select>
        <select aria-label={`${resourceId}规则${index + 1}效果`} className="rounded-md border bg-background px-2 py-2 text-sm" value={rule.effect} onChange={event => update(index, { ...rule, effect: event.target.value as Effect, origin: undefined })}>
          <option value="allow">允许</option><option value="deny">拒绝</option>
        </select>
        {rule.assigneeType === "everyone" ? <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm">全部 active membership</div> : <select aria-label={`${resourceId}规则${index + 1}主体`} className="rounded-md border bg-background px-2 py-2 text-sm" value={rule.assigneeId ?? ""} onChange={event => update(index, { ...rule, assigneeId: event.target.value || undefined, origin: undefined })}>
          <option value="">请选择权威主体</option>{!hasCurrent && rule.assigneeId ? <option value={rule.assigneeId}>{rule.assigneeId}（当前值）</option> : null}{options.map(option => <option key={option.id} value={option.id}>{option.label}（{option.id}）</option>)}
        </select>}
        <div className="flex items-center justify-end gap-2">{rule.origin ? <Badge variant="outline">来源：{rule.origin}</Badge> : null}<Button type="button" size="sm" variant="outline" onClick={() => onChange(rules.filter((_, i) => i !== index))}>删除</Button></div>
      </div>;
    }) : <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">没有规则，表示显式无人可用。</div>}
    <Button type="button" size="sm" variant="outline" onClick={() => onChange([...rules, { assigneeType: "everyone", effect: "allow" }])}>新增 Assignment 规则</Button>
  </div>;
}

function ResourceEditor({ tenantId, type, item, catalog, catalogError, onCommitted }: {
  tenantId: string;
  type: "knowledge" | "memory";
  item?: OrganizationResourceRecord;
  catalog: SubjectCatalog | null;
  catalogError: Error | null;
  onCommitted: () => void;
}) {
  const [open, setOpen] = useState(!item);
  const [resourceId, setResourceId] = useState(item?.resourceId ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [status, setStatus] = useState<"enabled" | "disabled">(item?.status ?? "enabled");
  const [rules, setRules] = useState<AssignmentRule[]>(item?.scope ?? []);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMemory = type === "memory";
  const normalizedRules = rules.map(({ assigneeType, assigneeId, effect }) => ({
    assigneeType, ...(assigneeType !== "everyone" && assigneeId ? { assigneeId } : {}), effect,
  }));
  const duplicateKeys = normalizedRules.map(rule => `${rule.assigneeType}:${rule.assigneeId ?? ""}:${rule.effect}`);
  const invalidRules = normalizedRules.some(rule => rule.assigneeType !== "everyone" && !rule.assigneeId)
    || new Set(duplicateKeys).size !== duplicateKeys.length;
  const knowledgeCommand = { expectedVersion: item?.version ?? 0, assignments: normalizedRules };
  const memoryCommand = { resourceId, name, status, assignments: normalizedRules, expectedVersion: item?.version ?? 0, reason };
  const resetPreview = () => { setPreview(null); setReceipt(null); setError(null); };
  const changeRules = (next: AssignmentRule[]) => { setRules(next); resetPreview(); };
  const runPreview = async () => {
    setBusy(true); setError(null); setReceipt(null);
    try {
      const next = isMemory
        ? await governanceAccessApi.previewMemoryResource<Preview>(memoryCommand, tenantId)
        : await governanceAccessApi.previewAssignment<Preview>("org_knowledge", resourceId, knowledgeCommand, tenantId);
      setPreview(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    const token = { previewId: preview.previewId, baselineDigest: preview.baselineDigest, expiresAt: preview.expiresAt };
    try {
      const next = isMemory
        ? await governanceAccessApi.updateMemoryResource<Receipt>(resourceId, { ...memoryCommand, ...token }, tenantId)
        : await governanceAccessApi.updateAssignment<Receipt>("org_knowledge", resourceId, { ...knowledgeCommand, ...token }, tenantId);
      setReceipt(next); setPreview(null); onCommitted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>管理安全范围</Button>;
  return <div className="mt-3 space-y-2 rounded-lg border p-3">
    {isMemory ? <div className="grid gap-2 sm:grid-cols-2">
      <input aria-label="记忆资源 ID" disabled={Boolean(item)} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="如 team-decisions" value={resourceId} onChange={event => { setResourceId(event.target.value); resetPreview(); }} />
      <input aria-label={`${resourceId || "新"}记忆名称`} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="组织记忆名称" value={name} onChange={event => { setName(event.target.value); resetPreview(); }} />
      <select aria-label={`${resourceId || "新"}记忆状态`} className="rounded-md border bg-background px-3 py-2 text-sm" value={status} onChange={event => { setStatus(event.target.value as "enabled" | "disabled"); resetPreview(); }}><option value="enabled">启用</option><option value="disabled">停用</option></select>
      <input aria-label={`${resourceId || "新"}记忆变更原因`} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="变更原因（至少 3 个字符）" value={reason} onChange={event => { setReason(event.target.value); resetPreview(); }} />
    </div> : null}
    {catalogError ? <div role="alert" className="text-xs text-destructive">权威成员、群组或 Agent 目录不可用：{catalogError.message}</div> : <RuleEditor resourceId={resourceId} rules={rules} catalog={catalog} onChange={changeRules} />}
    {invalidRules ? <div role="alert" className="text-xs text-destructive">每条规则必须选择主体，且不能重复。</div> : null}
    <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || !catalog || invalidRules || !resourceId || (isMemory && (!name || reason.trim().length < 3))} onClick={() => void runPreview()}>生成签名预览</Button>{preview ? <Button size="sm" disabled={busy || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void commit()}>确认提交</Button> : null}</div>
    {preview ? <div className="text-xs text-muted-foreground">预览已绑定 v{item?.version ?? 0} 基线，有效至 {new Date(preview.expiresAt).toLocaleString()}<details className="mt-1"><summary className="cursor-pointer">签名详情</summary><div className="break-all font-mono">{preview.previewId}<br />{preview.baselineDigest}</div></details></div> : null}
    {error ? <div role="alert" className="text-xs text-destructive">{error}</div> : null}<ReceiptView receipt={receipt} />
  </div>;
}

function ResourceList({ title, empty, type, items, tenantId, manageable, catalog, catalogError, onCommitted }: {
  title: string;
  empty: string;
  type: "knowledge" | "memory";
  items: OrganizationResourceRecord[];
  tenantId: string;
  manageable: boolean;
  catalog: SubjectCatalog | null;
  catalogError: Error | null;
  onCommitted: () => void;
}) {
  return <div className="rounded-xl border bg-card p-4"><div className="font-medium">{title}</div>{items.length ? <ul className="mt-2 divide-y">{items.map(item => <li key={item.resourceId} className="py-3"><div className="flex justify-between gap-3"><div><div className="font-medium">{item.name}</div><div className="font-mono text-xs text-muted-foreground">{item.resourceId}</div></div><Badge variant="outline">{item.status === "enabled" ? "启用" : "停用"}</Badge></div><div className="mt-2 text-xs text-muted-foreground">{item.scope ? `作用域：${item.scope.length ? item.scope.map(value => `${value.effect === "allow" ? "允许" : "禁止"} ${value.assigneeType}${value.assigneeId ? `:${value.assigneeId}` : ""}${value.origin ? ` [${value.origin}]` : ""}`).join("；") : "未指派"}` : "当前成员：effective assignment 已允许"} · v{item.version} · {new Date(item.updatedAt).toLocaleString()}</div>{item.scope && manageable ? <ResourceEditor tenantId={tenantId} type={type} item={item} catalog={catalog} catalogError={catalogError} onCommitted={onCommitted} /> : null}</li>)}</ul> : <div className="mt-3 text-sm text-muted-foreground">{empty}</div>}</div>;
}

export function MemoryKnowledgeGovernance({ tenantId, onNavigate }: {
  tenantId: string;
  onNavigate?: (view: "center" | "timeline" | "entities") => void;
}) {
  const request = useMemo(() => () => governanceAccessApi.listMemoryKnowledge<Response>(tenantId), [tenantId]);
  const subjectsRequest = useMemo(() => async (): Promise<SubjectCatalog> => {
    const [memberships, groups, agentsResponse] = await Promise.all([
      governanceAccessApi.listMemberships<{ memberships: Array<{ userId: string; status: string; directoryProfile?: { displayName?: string; username?: string } }> }>(tenantId),
      governanceAccessApi.listDirectoryGroups<{ groups: Array<{ groupId: string; displayName: string; status: string }> }>(tenantId),
      authFetch(`/api/org-agents?tenantId=${encodeURIComponent(tenantId)}`),
    ]);
    if (!agentsResponse.ok) throw new Error(`Agent 目录读取失败（HTTP ${agentsResponse.status}）`);
    const agents = await agentsResponse.json() as Array<{ id: string; name: string; enabled: boolean }>;
    return {
      users: memberships.memberships.filter(item => item.status === "active").map(item => ({ userId: item.userId,
        label: item.directoryProfile?.displayName ?? item.directoryProfile?.username ?? item.userId })),
      groups: groups.groups.filter(item => item.status === "active").map(item => ({ groupId: item.groupId, displayName: item.displayName })),
      agents: agents.filter(item => item.enabled).map(item => ({ id: item.id, name: item.name })),
    };
  }, [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `memory-knowledge:${tenantId}`);
  const subjects = useGovernanceRequest(subjectsRequest, `memory-knowledge-subjects:${tenantId}`);
  const [suiteReceipt, setSuiteReceipt] = useState<BatchReceipt | null>(null);
  const persistentReceipt = suiteReceipt ? <div role="status" className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm">最近一次 Assignment 已提交：{suiteReceipt.sets.map(set => `${set.resourceId} v${set.version}`).join("；")}。权威数据刷新期间仍保留此回执。</div> : null;
  if (loading) return <div className="space-y-3">{persistentReceipt}<div className="py-8 text-sm text-muted-foreground">正在读取权威治理数据…</div></div>;
  if (error) return <div className="space-y-3">{persistentReceipt}<GovernanceUnavailable error={error} onRetry={retry} /></div>;
  if (!data) return persistentReceipt;
  return <div className="space-y-5">
    <div><h2 className="text-lg font-semibold">企业上下文配置</h2><p className="mt-1 text-sm text-muted-foreground">管理员只需决定接入什么数据、谁能使用，以及如何确认生效；Collection 与复杂 Assignment 保留在高级配置。</p></div>
    <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border p-4 text-sm">组织知识策略：{data.effective.organizationKnowledge ? "启用" : "禁用"}</div><div className="rounded-xl border p-4 text-sm">组织记忆策略：{data.effective.organizationMemory ? "启用" : "禁用"}</div></div>
    {data.accessMode !== "effective_only" && data.suites.length ? <KnowledgeSuiteSetup tenantId={tenantId} suites={data.suites}
      manageable={data.accessMode === "manage"} receipt={suiteReceipt} onReceipt={setSuiteReceipt} onCommitted={retry} onNavigate={onNavigate} /> : null}
    {data.accessMode === "manage" ? <div className="rounded-xl border bg-card p-4"><div className="font-medium">创建组织记忆元数据</div><ResourceEditor tenantId={tenantId} type="memory" catalog={subjects.data} catalogError={subjects.error} onCommitted={retry} /></div> : null}
    <details className="rounded-xl border bg-muted/10 p-4"><summary className="cursor-pointer font-medium">高级配置：逐个 Collection、deny、群组与 Agent 规则</summary><p className="mt-2 text-sm text-muted-foreground">这里可以完整管理 everyone、成员、目录群组与 Agent 的 allow/deny；未修改的既有规则会保留 origin。</p><div className="mt-4 grid gap-4 xl:grid-cols-2"><ResourceList title="组织知识资源" empty="当前组织没有组织知识资源。" type="knowledge" items={data.knowledge} tenantId={tenantId} manageable={data.accessMode === "manage"} catalog={subjects.data} catalogError={subjects.error} onCommitted={retry} /><ResourceList title="组织记忆资源" empty="当前组织没有组织记忆资源。" type="memory" items={data.memory} tenantId={tenantId} manageable={data.accessMode === "manage"} catalog={subjects.data} catalogError={subjects.error} onCommitted={retry} /></div></details>
  </div>;
}
