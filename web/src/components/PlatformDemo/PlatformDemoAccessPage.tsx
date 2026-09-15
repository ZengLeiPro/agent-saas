import { useCallback, useEffect, useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useTenants } from "@/components/TenantManager/hooks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  fetchPlatformDemoGrantCandidates,
  fetchPlatformDemoGrants,
  grantPlatformDemoAccess,
  revokePlatformDemoAccess,
  type PlatformDemoCapabilityGrant,
  type PlatformDemoGrantCandidate,
} from "@agent/shared/lib/platformDemoApi";
import { filterCustomerOrganizations } from "@/lib/governanceNavigation";

function Empty({ children }: { children: string }) {
  return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

export function PlatformDemoAccessPage() {
  const { tenants, loading: tenantsLoading } = useTenants();
  const orgs = useMemo(() => filterCustomerOrganizations(tenants ?? []), [tenants]);
  const [grants, setGrants] = useState<PlatformDemoCapabilityGrant[]>([]);
  const [featureEnabled, setFeatureEnabled] = useState(true);
  const [featureDescription, setFeatureDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const [candidates, setCandidates] = useState<PlatformDemoGrantCandidate[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPlatformDemoGrants();
      setGrants(data.grants);
      setFeatureEnabled(data.featureEnabled);
      setFeatureDescription(data.featureFlag.description);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedTenantId) {
      setCandidates([]);
      setSelectedUserId("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchPlatformDemoGrantCandidates(selectedTenantId);
        if (cancelled) return;
        const granted = new Set(
          grants.filter((g) => g.tenantId === selectedTenantId).map((g) => g.userId),
        );
        setCandidates(data.candidates.filter((c) => !granted.has(c.userId)));
        setSelectedUserId("");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId, grants]);

  const onGrant = async () => {
    if (!selectedTenantId || !selectedUserId) return;
    setBusy(true);
    setError(null);
    try {
      await grantPlatformDemoAccess(selectedTenantId, selectedUserId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (tenantId: string, userId: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokePlatformDemoAccess(tenantId, userId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const orgName = (tenantId: string) =>
    orgs.find((t) => t.id === tenantId)?.name ?? tenantId;

  if (loading || tenantsLoading) {
    return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">正在读取演示访问权限…</div>;
  }

  return (
    <div className="space-y-6" data-testid="platform-demo-access-page">
      <SettingsPanelHeader
        title="演示访问"
        description="授予组织管理员进入平台管理演示模式。他们只能看到示例数据，保存不会影响平台。"
      />

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">全局演示入口</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {featureDescription ||
                "环境变量 PLATFORM_DEMO_MODE_ENABLED 为硬关闭开关；开启后由本面板管理授予。"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{featureEnabled ? "已开启" : "已关闭"}</span>
            <Switch
              checked={featureEnabled}
              disabled
              aria-label="全局演示入口（由环境变量控制）"
              title="由 PLATFORM_DEMO_MODE_ENABLED 控制，面板不可改写硬开关"
            />
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>被授予者仅能预览示例数据并体验保存流程；所有写入进入演示会话，不会影响生产平台配置。</span>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
          <Button type="button" size="sm" variant="outline" className="ml-3" onClick={() => void refresh()}>
            重试
          </Button>
        </div>
      ) : null}

      <div className="space-y-3 rounded-xl border bg-card p-4">
        <div className="font-medium">新增授予</div>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <Select value={selectedTenantId || undefined} onValueChange={setSelectedTenantId}>
            <SelectTrigger aria-label="选择组织">
              <SelectValue placeholder="选择组织" />
            </SelectTrigger>
            <SelectContent>
              {orgs.map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}（{org.id}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={selectedUserId || undefined}
            onValueChange={setSelectedUserId}
            disabled={!selectedTenantId || candidates.length === 0}
          >
            <SelectTrigger aria-label="选择组织管理员">
              <SelectValue placeholder={selectedTenantId ? (candidates.length ? "选择组织管理员" : "该组织没有可授予的管理员") : "先选择组织"} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((item) => (
                <SelectItem key={item.userId} value={item.userId}>
                  {item.userId}{item.isOwner ? " · 所有者" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" disabled={busy || !selectedTenantId || !selectedUserId} onClick={() => void onGrant()}>
            授予演示权限
          </Button>
        </div>
      </div>

      {!grants.length ? (
        <Empty>尚未授予任何组织管理员演示访问权限。</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card" tabIndex={0}>
          <table className="min-w-[720px] w-full text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-3">组织</th>
                <th className="px-4 py-3">用户</th>
                <th className="px-4 py-3">授予时间</th>
                <th className="px-4 py-3">授予人</th>
                <th className="px-4 py-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {grants.map((grant) => (
                <tr key={`${grant.tenantId}::${grant.userId}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{orgName(grant.tenantId)}</div>
                    <div className="font-mono text-xs text-muted-foreground">{grant.tenantId}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{grant.userId}</td>
                  <td className="px-4 py-3">{new Date(grant.grantedAt).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline">{grant.grantedBy}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`撤销 ${grant.userId} 的演示权限`}
                      onClick={() => void onRevoke(grant.tenantId, grant.userId)}
                    >
                      撤销
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
