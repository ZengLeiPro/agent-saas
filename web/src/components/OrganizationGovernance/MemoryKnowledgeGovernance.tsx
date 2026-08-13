import { useMemo, useState } from "react";

import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";

interface OrganizationResourceRecord {
  resourceId: string; name: string; status: "enabled" | "disabled"; policyEnabled: boolean;
  scope?: Array<{ assigneeType: string; assigneeId?: string; effect: "allow" | "deny" }>;
  effectiveAssignment?: "assigned"; source: string; version: number; updatedAt: string;
}
interface Response {
  tenantId: string; authority: "governance_assignment_sets"; accessMode: "manage" | "inspect" | "effective_only";
  knowledge: OrganizationResourceRecord[]; memory: OrganizationResourceRecord[];
  effective: { organizationKnowledge: boolean; organizationMemory: boolean };
}
interface Preview { previewId: string; baselineDigest: string; expiresAt: string; impact: Record<string, unknown>; changeId: string }
interface Receipt { changeId: string; auditId: string; effectiveAt?: string; version?: number }
type Scope = "everyone" | "selected";

function initialScope(item?: OrganizationResourceRecord): Scope {
  return item?.scope?.some(scope => scope.assigneeType === "everyone" && scope.effect === "allow") ? "everyone" : "selected";
}
function initialUsers(item?: OrganizationResourceRecord): string {
  return item?.scope?.filter(scope => scope.assigneeType === "user" && scope.effect === "allow" && scope.assigneeId).map(scope => scope.assigneeId).join(", ") ?? "";
}
function assignments(scope: Scope, userIds: string) {
  if (scope === "everyone") return [{ assigneeType: "everyone", effect: "allow" }];
  return [...new Set(userIds.split(",").map(value => value.trim()).filter(Boolean))]
    .map(assigneeId => ({ assigneeType: "user", assigneeId, effect: "allow" }));
}
function simpleScope(item?: OrganizationResourceRecord): boolean {
  return (item?.scope ?? []).every(scope => scope.effect === "allow" && (scope.assigneeType === "everyone" || scope.assigneeType === "user"));
}
function ReceiptView({ receipt }: { receipt: Receipt | null }) {
  if (!receipt) return null;
  return <div className="mt-2 rounded border bg-muted/20 p-2 text-xs">changeId：{receipt.changeId}<br />auditId：{receipt.auditId}{receipt.effectiveAt ? <><br />生效：{new Date(receipt.effectiveAt).toLocaleString()}</> : null}</div>;
}

function ResourceEditor({ tenantId, type, item, onCommitted }: {
  tenantId: string; type: "knowledge" | "memory"; item?: OrganizationResourceRecord; onCommitted: () => void;
}) {
  const [open, setOpen] = useState(!item);
  const [resourceId, setResourceId] = useState(item?.resourceId ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [status, setStatus] = useState<"enabled" | "disabled">(item?.status ?? "enabled");
  const [scope, setScope] = useState<Scope>(initialScope(item));
  const [userIds, setUserIds] = useState(initialUsers(item));
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isMemory = type === "memory";
  const canEdit = simpleScope(item);
  const resetPreview = () => { setPreview(null); setReceipt(null); };
  const mutationAssignments = assignments(scope, userIds);
  const memoryCommand = { resourceId, name, status, assignments: mutationAssignments, expectedVersion: item?.version ?? 0, reason };
  const knowledgeCommand = { expectedVersion: item?.version ?? 0, assignments: mutationAssignments };
  const runPreview = async () => {
    setBusy(true); setError(null);
    try {
      const next = isMemory
        ? await governanceAccessApi.previewMemoryResource<Preview>(memoryCommand, tenantId)
        : await governanceAccessApi.previewAssignment<Preview>("org_knowledge", resourceId, knowledgeCommand, tenantId);
      setPreview(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>管理安全范围</Button>;
  if (!canEdit) return <div className="mt-2 text-xs text-amber-700">当前包含目录组、Agent 或拒绝规则；为避免覆盖复杂语义，本表单保持只读。</div>;
  return <div className="mt-3 space-y-2 rounded-lg border p-3">
    {isMemory ? <div className="grid gap-2 sm:grid-cols-2">
      <input aria-label="记忆资源 ID" disabled={Boolean(item)} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="如 team-decisions" value={resourceId} onChange={event => { setResourceId(event.target.value); resetPreview(); }} />
      <input aria-label={`${resourceId || "新"}记忆名称`} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="组织记忆名称" value={name} onChange={event => { setName(event.target.value); resetPreview(); }} />
      <select aria-label={`${resourceId || "新"}记忆状态`} className="rounded-md border bg-background px-3 py-2 text-sm" value={status} onChange={event => { setStatus(event.target.value as "enabled" | "disabled"); resetPreview(); }}><option value="enabled">启用</option><option value="disabled">停用</option></select>
      <input aria-label={`${resourceId || "新"}记忆变更原因`} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="变更原因（至少 3 个字符）" value={reason} onChange={event => { setReason(event.target.value); resetPreview(); }} />
    </div> : null}
    <select aria-label={`${resourceId}成员范围`} className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={scope} onChange={event => { setScope(event.target.value as Scope); resetPreview(); }}><option value="everyone">所有有效成员</option><option value="selected">指定成员</option></select>
    {scope === "selected" ? <input aria-label={`${resourceId}成员 ID`} className="w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="同组织成员 ID，逗号分隔；留空表示无人可用" value={userIds} onChange={event => { setUserIds(event.target.value); resetPreview(); }} /> : null}
    <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || !resourceId || (isMemory && (!name || reason.trim().length < 3))} onClick={() => void runPreview()}>生成签名预览</Button>{preview ? <Button size="sm" disabled={busy || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void commit()}>确认提交</Button> : null}</div>
    {preview ? <div className="text-xs text-muted-foreground">预览已绑定 v{item?.version ?? 0} 基线，有效至 {new Date(preview.expiresAt).toLocaleString()}</div> : null}
    {error ? <div role="alert" className="text-xs text-destructive">{error}</div> : null}<ReceiptView receipt={receipt} />
  </div>;
}

function ResourceList({ title, empty, type, items, tenantId, manageable, onCommitted }: {
  title: string; empty: string; type: "knowledge" | "memory"; items: OrganizationResourceRecord[]; tenantId: string; manageable: boolean; onCommitted: () => void;
}) {
  return <div className="rounded-xl border bg-card p-4"><div className="font-medium">{title}</div>{items.length ? <ul className="mt-2 divide-y">{items.map(item => <li key={item.resourceId} className="py-3"><div className="flex justify-between gap-3"><div><div className="font-medium">{item.name}</div><div className="font-mono text-xs text-muted-foreground">{item.resourceId}</div></div><Badge variant="outline">{item.status === "enabled" ? "启用" : "停用"}</Badge></div><div className="mt-2 text-xs text-muted-foreground">{item.scope ? `作用域：${item.scope.length ? item.scope.map(value => `${value.effect === "allow" ? "允许" : "禁止"} ${value.assigneeType}${value.assigneeId ? `:${value.assigneeId}` : ""}`).join("；") : "未指派"}` : "当前成员：effective assignment 已允许"} · v{item.version} · {new Date(item.updatedAt).toLocaleString()}</div>{item.scope && manageable ? <ResourceEditor tenantId={tenantId} type={type} item={item} onCommitted={onCommitted} /> : null}</li>)}</ul> : <div className="mt-3 text-sm text-muted-foreground">{empty}</div>}</div>;
}

export function MemoryKnowledgeGovernance({ tenantId }: { tenantId: string }) {
  const request = useMemo(() => () => governanceAccessApi.listMemoryKnowledge<Response>(tenantId), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `memory-knowledge:${tenantId}`);
  if (loading) return <div className="py-8 text-sm text-muted-foreground">正在读取权威治理数据…</div>;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  if (!data) return null;
  return <div><div className="mb-4"><h2 className="text-lg font-semibold">记忆与知识</h2><p className="mt-1 text-sm text-muted-foreground">仅治理组织级元数据与 Assignment 范围；绝不读取或展示个人 MEMORY 正文及成员私有信息。</p></div><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border p-4 text-sm">组织知识策略：{data.effective.organizationKnowledge ? "启用" : "禁用"}</div><div className="rounded-xl border p-4 text-sm">组织记忆策略：{data.effective.organizationMemory ? "启用" : "禁用"}</div></div>{data.accessMode === "manage" ? <div className="mt-4 rounded-xl border bg-card p-4"><div className="font-medium">创建组织记忆元数据</div><ResourceEditor tenantId={tenantId} type="memory" onCommitted={retry} /></div> : null}<div className="mt-4 grid gap-4 xl:grid-cols-2"><ResourceList title="组织知识资源" empty="当前组织没有组织知识资源。" type="knowledge" items={data.knowledge} tenantId={tenantId} manageable={data.accessMode === "manage"} onCommitted={retry} /><ResourceList title="组织记忆资源" empty="当前组织没有组织记忆资源。" type="memory" items={data.memory} tenantId={tenantId} manageable={data.accessMode === "manage"} onCommitted={retry} /></div></div>;
}
