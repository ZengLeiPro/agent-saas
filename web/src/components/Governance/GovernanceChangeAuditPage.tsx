import { useMemo } from "react";
import { RefreshCw } from "lucide-react";

import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";

interface GovernanceAuditEvent {
  auditId: string;
  changeId?: string;
  actorUserId: string;
  actorPersona: string;
  action: string;
  targetType: string;
  targetId: string;
  targetTenantId?: string;
  purpose: string;
  reason?: string;
  result: "intent" | "succeeded" | "failed";
  occurredAt: string;
}

interface GovernanceAuditResponse {
  events: GovernanceAuditEvent[];
  nextBefore?: string;
}

export function GovernanceChangeAuditPage({ tenantId }: { tenantId?: string }) {
  const request = useMemo(() => () => governanceAccessApi.listAuditEvents<GovernanceAuditResponse>({
    ...(tenantId ? { tenantId } : {}), limit: 100,
  }), [tenantId]);
  const { data, loading, error, retry } = useGovernanceRequest(request, `governance-audit:${tenantId ?? "platform"}`);
  if (loading) return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取治理审计…</div>;
  if (error) return <GovernanceUnavailable error={error} onRetry={retry} />;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">治理审计</h2><p className="mt-1 text-sm text-muted-foreground">只展示权威治理账本中的身份、授权、策略与资源配置变更，不混入普通行为日志。</p></div><Button type="button" variant="outline" onClick={retry}><RefreshCw className="mr-2 size-4" />刷新</Button></div>
    {!data?.events.length ? <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">当前作用域没有治理审计事件。</div> : <div className="overflow-x-auto rounded-xl border bg-card" tabIndex={0} aria-label="治理审计列表，可横向滚动"><table className="min-w-[900px] w-full text-sm"><thead className="bg-muted/50 text-left text-muted-foreground"><tr><th className="px-4 py-3">时间</th><th className="px-4 py-3">操作者</th><th className="px-4 py-3">动作</th><th className="px-4 py-3">目标</th><th className="px-4 py-3">结果</th><th className="px-4 py-3">回执</th></tr></thead><tbody className="divide-y">{data.events.map(event => <tr key={event.auditId}><td className="whitespace-nowrap px-4 py-3">{new Date(event.occurredAt).toLocaleString()}</td><td className="px-4 py-3"><div className="font-mono text-xs">{event.actorUserId}</div><div className="text-xs text-muted-foreground">{event.actorPersona}</div></td><td className="px-4 py-3"><div>{event.action}</div><div className="text-xs text-muted-foreground">{event.purpose}</div></td><td className="px-4 py-3"><div>{event.targetType}</div><div className="font-mono text-xs text-muted-foreground">{event.targetId}</div></td><td className="px-4 py-3"><Badge variant={event.result === "succeeded" ? "secondary" : event.result === "failed" ? "destructive" : "outline"}>{event.result}</Badge></td><td className="px-4 py-3 font-mono text-xs">{event.changeId ?? event.auditId}</td></tr>)}</tbody></table></div>}
  </div>;
}
