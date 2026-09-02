import { useEffect, useMemo, useState } from "react";
import { Database, Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EntityIcons, StatusIcons } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import { useSettingsDirtyEntry } from "@/components/PersonalSettings/dirtyRegistry";
import { contextCenterApi, governanceAccessApi } from "@agent/shared/lib/governanceApi";

export interface KnowledgeSuite {
  suiteId: string;
  name: string;
  description: string;
  policyEnabled: boolean;
  resourceIds: string[];
  expectedResourceIds: string[];
  missingResourceIds: string[];
  unknownResourceIds: string[];
  completeness: "complete" | "incomplete" | "attention";
  resources: Array<{ resourceId: string; name: string; version: number; status: "enabled" | "disabled" }>;
  configuration: {
    mode: "none" | "all" | "selected" | "advanced" | "mixed";
    userIds: string[];
    groupIds: string[];
  };
}

interface Membership {
  userId: string;
  status: "active" | "disabled";
  directoryProfile?: { displayName?: string; username?: string; accountStatus?: string };
}
interface DirectoryGroup { groupId: string; displayName: string; status: "active" | "disabled" }
interface DirectoryData { memberships: Membership[]; groups: DirectoryGroup[] }
const GovernanceIcon = EntityIcons.admin;
const SuccessIcon = StatusIcons.success;
interface PreviewSubject { assigneeType: string; assigneeId?: string; effect: string; label: string }
interface BatchPreview {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  changes: Array<{
    resourceId: string;
    before: PreviewSubject[];
    after: PreviewSubject[];
    addedCount: number;
    removedCount: number;
    beforeUserCount: number;
    afterUserCount: number;
    addedUserCount: number;
    removedUserCount: number;
  }>;
  impact: {
    resourceCount: number;
    directSubjectCount: number;
    effectiveUserCount: number;
    addedUserCount: number;
    removedUserCount: number;
    agentRuleCount: number;
    atomic: true;
    requiresNewSession: boolean;
  };
}
export interface BatchReceipt {
  auditId?: string;
  effectiveAt?: string;
  projectionStatus?: string;
  sets: Array<{ resourceId: string; version: number }>;
}
type SimpleMode = "all" | "selected";

function selectedLabel(member: Membership): string {
  return member.directoryProfile?.displayName ?? member.directoryProfile?.username ?? member.userId;
}

export function KnowledgeSuiteSetup({ tenantId, suites, manageable, receipt, onReceipt, onCommitted, onNavigate }: {
  tenantId: string;
  suites: KnowledgeSuite[];
  manageable: boolean;
  receipt: BatchReceipt | null;
  onReceipt: (receipt: BatchReceipt | null) => void;
  onCommitted: () => void;
  onNavigate?: (view: "center" | "timeline" | "entities") => void;
}) {
  const directoryRequest = useMemo(() => async (): Promise<DirectoryData> => {
    const [memberships, groups] = await Promise.all([
      governanceAccessApi.listMemberships<{ memberships: Membership[] }>(tenantId),
      governanceAccessApi.listDirectoryGroups<{ groups: DirectoryGroup[] }>(tenantId),
    ]);
    return { memberships: memberships.memberships, groups: groups.groups };
  }, [tenantId]);
  const snapshotRequest = useMemo(() => () => contextCenterApi.getSnapshot({ tenantId }), [tenantId]);
  const directory = useGovernanceRequest(directoryRequest, `knowledge-suite-directory:${tenantId}`);
  const snapshot = useGovernanceRequest(snapshotRequest, `knowledge-suite-snapshot:${tenantId}`);
  const [suiteId, setSuiteId] = useState(suites.find(item => item.suiteId === "taskboard")?.suiteId ?? suites[0]?.suiteId ?? "");
  const suite = suites.find(item => item.suiteId === suiteId) ?? suites[0];
  const [mode, setMode] = useState<SimpleMode>("selected");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const defaultReason = "配置企业上下文使用范围";
  const [reason, setReason] = useState(defaultReason);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!suite) return;
    setMode(suite.configuration.mode === "all" ? "all" : "selected");
    setUserIds(suite.configuration.userIds);
    setGroupIds(suite.configuration.groupIds);
    setPreview(null);
    setError(null);
  }, [suite?.suiteId, suite?.configuration.mode, suite?.configuration.userIds.join("\u0000"), suite?.configuration.groupIds.join("\u0000")]);

  if (!suite) return <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">当前没有可配置的数据源。</div>;
  const simple = suite.configuration.mode !== "advanced" && suite.configuration.mode !== "mixed";
  const complete = (suite.completeness ?? "complete") === "complete";
  const syncLabel = (item: KnowledgeSuite) => {
    if (snapshot.loading) return "同步状态读取中";
    if (snapshot.error) return "同步状态不可用";
    const sources = (snapshot.data?.sources ?? []).filter(source => item.resourceIds.includes(source.collectionId));
    return !sources.length ? "未发现同步记录" : sources.every(source => source.status === "healthy") ? "同步正常"
      : sources.some(source => source.status === "attention" || source.status === "paused") ? "同步需处理" : "同步中";
  };
  const activeMembers = (directory.data?.memberships ?? []).filter(item => item.status === "active");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleMembers = activeMembers.filter(item => !normalizedSearch
    || `${selectedLabel(item)} ${item.directoryProfile?.username ?? ""} ${item.userId}`.toLocaleLowerCase().includes(normalizedSearch));
  const activeGroups = (directory.data?.groups ?? []).filter(item => item.status === "active");
  const assignments = mode === "all" ? [{ assigneeType: "everyone", effect: "allow" }]
    : [...userIds.map(assigneeId => ({ assigneeType: "user", assigneeId, effect: "allow" })),
      ...groupIds.map(assigneeId => ({ assigneeType: "directory_group", assigneeId, effect: "allow" }))];
  const command = { reason: reason.trim(), changes: suite.resources.map(resource => ({
    resourceType: "org_knowledge", resourceId: resource.resourceId, expectedVersion: resource.version, assignments,
  })) };
  const resetPreview = () => { setPreview(null); onReceipt(null); setError(null); };
  const toggle = (values: string[], value: string, update: (next: string[]) => void) => {
    update(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
    resetPreview();
  };
  const runPreview = async () => {
    setBusy(true); setError(null); onReceipt(null);
    try { setPreview(await governanceAccessApi.previewAssignmentBatch<BatchPreview>(command, tenantId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "预览失败"); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview) return false;
    setBusy(true); setError(null);
    try {
      const result = await governanceAccessApi.updateAssignmentBatch<BatchReceipt>({ ...command,
        previewId: preview.previewId, baselineDigest: preview.baselineDigest, expiresAt: preview.expiresAt }, tenantId);
      onReceipt(result); setPreview(null); onCommitted(); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "提交失败"); return false; }
    finally { setBusy(false); }
  };

  const baselineMode = suite?.configuration.mode === "all" ? "all" : "selected";
  const baselineUserIds = [...(suite?.configuration.userIds ?? [])].sort();
  const baselineGroupIds = [...(suite?.configuration.groupIds ?? [])].sort();
  const draftUserIds = [...userIds].sort();
  const draftGroupIds = [...groupIds].sort();
  const changed = Boolean(suite && (mode !== baselineMode || reason !== defaultReason
    || JSON.stringify(draftUserIds) !== JSON.stringify(baselineUserIds)
    || JSON.stringify(draftGroupIds) !== JSON.stringify(baselineGroupIds)));
  useSettingsDirtyEntry({
    id: `organization-knowledge-suite:${tenantId}:${suite?.suiteId ?? "none"}`,
    label: `${suite?.name ?? "组织知识"}使用范围`,
    dirty: !receipt && changed,
    save: async () => { if (!preview) { setError("请先生成签名预览，再保存并离开。"); throw new Error("Knowledge suite preview required"); } if (!await commit()) throw new Error("Knowledge suite commit failed"); },
    discard: () => {
      setMode(baselineMode); setUserIds(suite?.configuration.userIds ?? []); setGroupIds(suite?.configuration.groupIds ?? []);
      setReason(defaultReason); setPreview(null); setError(null); onReceipt(null);
    },
    draft: { mode, userIds: draftUserIds, groupIds: draftGroupIds, reason },
  });

  return <div className="space-y-5">
    <section aria-labelledby="context-step-source">
      <div className="mb-2 flex items-center gap-2"><Badge>1</Badge><h3 id="context-step-source" className="font-semibold">接入什么数据</h3></div>
      <div className="grid gap-3 md:grid-cols-2">{suites.map(item => <button key={item.suiteId} type="button" aria-pressed={item.suiteId === suite.suiteId}
        className={`rounded-xl border p-4 text-left transition ${item.suiteId === suite.suiteId ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
        onClick={() => setSuiteId(item.suiteId)}>
        <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 font-medium"><Database className="size-4" />{item.name}</span><span className="flex flex-wrap justify-end gap-1"><Badge variant="outline">{syncLabel(item)}</Badge><Badge variant="outline">{item.policyEnabled ? "策略已启用" : "策略已停用"}</Badge></span></div>
        <p className="mt-2 text-sm text-muted-foreground">{item.description}</p>
        <p className="mt-2 text-xs text-muted-foreground">包含 {item.resourceIds.length} 个 Collection</p>
        {(item.completeness ?? "complete") !== "complete" ? <div className="mt-2 text-xs text-warning-ink">{item.missingResourceIds?.length ? `缺少：${item.missingResourceIds.join("、")}` : ""}{item.unknownResourceIds?.length ? `${item.missingResourceIds?.length ? "；" : ""}待归类：${item.unknownResourceIds.join("、")}` : ""}</div> : null}
      </button>)}</div>
      {snapshot.error ? <div role="alert" className="mt-2 text-sm text-destructive">同步状态不可用：{snapshot.error.message}。这不等于没有同步记录。</div> : null}
    </section>

    <section aria-labelledby="context-step-scope">
      <div className="mb-2 flex items-center gap-2"><Badge>2</Badge><h3 id="context-step-scope" className="font-semibold">谁能使用</h3></div>
      {!manageable ? <div className="rounded-lg border bg-muted/30 p-3 text-sm">当前为只读检查模式；平台管理员不能代替客户组织提交授权。</div>
        : !complete ? <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning-ink">套件定义不完整，已禁止简单提交。请先补齐缺失 Collection 或归类未知资源。</div>
          : !simple ? <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning-ink">该套件包含 deny、Agent 或不一致规则。简单表单不会覆盖它，请在下方“高级配置”逐个 Collection 管理。</div>
            : <Card><CardContent className="space-y-4 p-4">
              <div className="grid gap-2 sm:grid-cols-2"><label className={`rounded-lg border p-3 ${mode === "all" ? "border-primary" : ""}`}><input type="radio" name="suite-scope" checked={mode === "all"} onChange={() => { setMode("all"); resetPreview(); }} /> <span className="ml-2 font-medium">所有有效成员</span><p className="ml-6 mt-1 text-xs text-muted-foreground">仍需通过来源系统原生 ACL。</p></label><label className={`rounded-lg border p-3 ${mode === "selected" ? "border-primary" : ""}`}><input type="radio" name="suite-scope" checked={mode === "selected"} onChange={() => { setMode("selected"); resetPreview(); }} /> <span className="ml-2 font-medium">指定成员或部门</span><p className="ml-6 mt-1 text-xs text-muted-foreground">留空表示显式无人可用。</p></label></div>
              {mode === "selected" ? directory.loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取组织目录</div> : directory.error ? <div role="alert" className="text-sm text-destructive">组织目录不可用：{directory.error.message}</div> : <div className="grid gap-4 lg:grid-cols-2"><div><div className="relative mb-2"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="搜索成员" className="pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="按姓名、账号或 ID 搜索" /></div><div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2">{visibleMembers.map(member => <label key={member.userId} className="flex items-start gap-2 rounded p-2 text-sm hover:bg-muted"><input type="checkbox" checked={userIds.includes(member.userId)} onChange={() => toggle(userIds, member.userId, setUserIds)} /><span><span className="font-medium">{selectedLabel(member)}</span><span className="block font-mono text-xs text-muted-foreground">{member.userId}</span></span></label>)}</div></div><div><div className="mb-2 text-sm font-medium">部门 / 目录群组</div><div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2">{activeGroups.length ? activeGroups.map(group => <label key={group.groupId} className="flex items-start gap-2 rounded p-2 text-sm hover:bg-muted"><input type="checkbox" checked={groupIds.includes(group.groupId)} onChange={() => toggle(groupIds, group.groupId, setGroupIds)} /><span><span className="font-medium">{group.displayName}</span><span className="block font-mono text-xs text-muted-foreground">{group.groupId}</span></span></label>) : <p className="p-2 text-sm text-muted-foreground">没有可用的目录群组。</p>}</div></div></div> : null}
            </CardContent></Card>}
    </section>

    <section aria-labelledby="context-step-verify">
      <div className="mb-2 flex items-center gap-2"><Badge>3</Badge><h3 id="context-step-verify" className="font-semibold">预览、提交并确认生效</h3></div>
      <div className="space-y-3 rounded-xl border p-4"><Input aria-label="授权变更原因" value={reason} onChange={event => { setReason(event.target.value); resetPreview(); }} placeholder="说明为什么修改授权" />
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!manageable || !complete || !simple || busy || reason.trim().length < 3 || (mode === "selected" && Boolean(directory.loading || directory.error))} onClick={() => void runPreview()}>{busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <GovernanceIcon className="mr-1.5 size-4" />}预览完整差异</Button>{preview ? <Button disabled={busy || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void commit()}>原子提交 {preview.impact.resourceCount} 个 Collection</Button> : null}</div>
        {preview ? <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-muted/50"><tr><th className="p-3">Collection</th><th className="p-3">当前范围</th><th className="p-3">目标范围</th><th className="p-3">规则差异</th><th className="p-3">人数差异</th></tr></thead><tbody>{preview.changes.map(change => <tr key={change.resourceId} className="border-t"><td className="p-3 font-mono text-xs">{change.resourceId}</td><td className="p-3">{change.before.map(item => `${item.effect === "allow" ? "允许" : "拒绝"} ${item.label}${item.assigneeId ? `（${item.assigneeId}）` : ""}`).join("；") || "无人可用"}</td><td className="p-3">{change.after.map(item => `${item.effect === "allow" ? "允许" : "拒绝"} ${item.label}${item.assigneeId ? `（${item.assigneeId}）` : ""}`).join("；") || "无人可用"}</td><td className="p-3">+{change.addedCount} / -{change.removedCount}</td><td className="p-3">{change.beforeUserCount} → {change.afterUserCount}（+{change.addedUserCount} / -{change.removedUserCount}）</td></tr>)}</tbody></table><div className="border-t bg-muted/30 p-3 text-xs text-muted-foreground">原子边界：Assignment 与全部 projection outbox 同一事务提交；预计影响 {preview.impact.effectiveUserCount} 名有效成员（新增 {preview.impact.addedUserCount}，移除 {preview.impact.removedUserCount}）；有效至 {new Date(preview.expiresAt).toLocaleString()}。<details className="mt-1"><summary className="cursor-pointer">高级签名信息</summary><div className="mt-1 break-all font-mono">previewId：{preview.previewId}<br />baselineDigest：{preview.baselineDigest}</div></details></div></div> : null}
        {receipt ? <div role="status" className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm"><div className="flex items-center gap-2 font-medium text-success-ink"><SuccessIcon className="size-4" />Assignment 已提交，需新建 Agent 会话验收</div><p className="mt-1 text-muted-foreground">版本：{receipt.sets.map(set => `${set.resourceId} v${set.version}`).join("；")}{receipt.auditId ? ` · 审计 ${receipt.auditId}` : ""} · 兼容投影：{receipt.projectionStatus === "pending" ? "已持久化，待处理" : "未配置"}</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" asChild><a href="/">新建 Agent 会话</a></Button><Button size="sm" variant="outline" onClick={() => onNavigate?.("center")}>检查同步</Button><Button size="sm" variant="outline" onClick={() => onNavigate?.("timeline")}>验收 Timeline</Button><Button size="sm" variant="outline" onClick={() => onNavigate?.("entities")}>验收实体</Button></div></div> : null}
        {error ? <div role="alert" className="text-sm text-destructive">{error}</div> : null}
      </div>
    </section>
  </div>;
}
