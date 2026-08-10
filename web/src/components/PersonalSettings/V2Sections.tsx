import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { KeyRound, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { AgentDocEditor } from "@/components/AgentProfile/AgentDocEditor";
import { EffectiveResourceList } from "@/components/Governance/EffectiveResourceList";
import { PermissionWhyPanel } from "@/components/Governance/PermissionWhyPanel";
import { AttachmentStorageSection } from "@/components/SettingsCenter/AttachmentStorageSection";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { useEffectiveResources } from "@/hooks/useEffectiveResources";
import { navigateSettingsRoute } from "@/lib/urlSync";
import { EntityIcons } from "@/lib/icons";
import { governanceRoute, parseGovernanceUrl } from "@/lib/governanceNavigation";
import { fetchMyMcp, saveUserPreferences } from "@agent/shared";
import type { MyMcpResponse } from "@agent/shared";
import type { MyAgentSettingsTab } from "@/types/settings";

function readMyAgentTab(): MyAgentSettingsTab {
  const parsed = parseGovernanceUrl(`${window.location.pathname}${window.location.search}`);
  if (parsed.kind !== "route" || parsed.route.routeId !== "settings.personal.my-agent") return "agent-profile";
  return (parsed.route.tab as MyAgentSettingsTab | null) ?? "agent-profile";
}

export function MyAgentSection({
  renderProfile,
  renderMemory,
}: {
  renderProfile: (openPersona: () => void) => ReactNode;
  renderMemory?: () => ReactNode;
}) {
  const { user } = useAuth();
  const [tab, setTab] = useState<MyAgentSettingsTab>(() => readMyAgentTab());

  useEffect(() => {
    const sync = () => setTab(readMyAgentTab());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const changeTab = useCallback((next: string) => {
    const value = next as MyAgentSettingsTab;
    setTab(value);
    navigateSettingsRoute(governanceRoute("settings.personal.my-agent", { tab: value }));
  }, []);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader title="我的 Agent" description="在资料、Persona 与长期 Memory 之间切换；深链刷新会保留当前 Tab。" />
      <Tabs value={tab} onValueChange={changeTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mb-4 w-fit">
          <TabsTrigger value="agent-profile">资料</TabsTrigger>
          <TabsTrigger value="persona">Persona</TabsTrigger>
          <TabsTrigger value="memory">长期 Memory</TabsTrigger>
        </TabsList>
        <TabsContent value="agent-profile" className="min-h-0 flex-1 overflow-auto">
          {renderProfile(() => changeTab("persona"))}
        </TabsContent>
        <TabsContent value="persona" className="min-h-0 flex-1">
          {user?.username ? <AgentDocEditor username={user.username} kind="persona" hideInternalHeader /> : null}
        </TabsContent>
        <TabsContent value="memory" className="min-h-0 flex-1">
          {renderMemory?.() ?? (user?.username ? <AgentDocEditor username={user.username} kind="memory" hideInternalHeader /> : null)}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function MyPermissionsSection() {
  const request = useEffectiveResources();
  const authoritativeExample = request.data?.[0] ?? null;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="我的权限"
        description="只展示服务端返回的有效资源与七层权限解释；前端不会本地推导或在失败时降级放行。"
        actions={<Button type="button" size="sm" variant="outline" onClick={request.retry} disabled={request.loading}>{request.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button>}
      />
      <div className="min-h-0 flex-1 space-y-6 overflow-auto pb-4">
        <EffectiveResourceList resources={request.data} loading={request.loading} error={request.error} onRetry={request.retry} />
        {authoritativeExample ? <PermissionWhyPanel evaluation={authoritativeExample} /> : null}
      </div>
    </div>
  );
}

function connectionStatusLabel(status?: string): string {
  if (status === "connected") return "已连接（旧连接）";
  if (status === "pending") return "授权处理中（旧连接）";
  if (status === "error") return "连接异常（旧连接）";
  return "未连接";
}

export function ConnectionsSection() {
  const { user, updatePreferences } = useAuth();
  const [connections, setConnections] = useState<MyMcpResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingApproval, setSavingApproval] = useState(false);
  const authorizationModeEnabled = user?.preferences?.authorizationModeEnabled === true;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConnections(await fetchMyMcp());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取旧连接失败");
      setConnections(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const updateRuntimeApproval = useCallback(async (checked: boolean) => {
    setSavingApproval(true);
    try {
      const saved = await saveUserPreferences({ authorizationModeEnabled: checked });
      if (!saved) throw new Error("保存失败");
      updatePreferences(saved);
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSavingApproval(false);
    }
  }, [updatePreferences]);

  const legacyOauthConnections = useMemo(
    () => connections?.servers.filter((server) => server.oauth) ?? [],
    [connections],
  );

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader title="连接与授权" description="长期账号授权与单次运行时工具批准是两类独立能力，不互相冒充。" />
      <div className="min-h-0 flex-1 space-y-5 overflow-auto pb-4">
        <section className="rounded-2xl border bg-card p-5 shadow-sm" aria-labelledby="long-term-authorizations">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <h2 id="long-term-authorizations" className="font-semibold">长期账号授权</h2>
              <p className="mt-1 text-sm text-muted-foreground">新版 OAuth Grant API 尚未提供。以下旧连接仅只读展示，尚未迁移到权威长期授权模型；本页不会发起、撤销或伪造授权成功。</p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => { void load(); }} disabled={loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button>
          </div>
          {error ? <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</div> : null}
          {!loading && !error ? (
            legacyOauthConnections.length ? (
              <ul className="mt-4 divide-y rounded-xl border">
                {legacyOauthConnections.map((server) => (
                  <li key={server.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                    <div><div className="font-medium">{server.name}</div><div className="text-xs text-muted-foreground">{server.oauth?.provider}</div></div>
                    <span className="rounded-full bg-muted px-2 py-1 text-xs">{connectionStatusLabel(server.oauth?.status)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-4 text-sm text-muted-foreground">没有可只读展示的旧 OAuth 连接。</p>
          ) : null}
        </section>

        <section className="rounded-2xl border bg-card p-5 shadow-sm" aria-labelledby="runtime-tool-approval">
          <div className="flex items-start gap-3">
            <EntityIcons.admin className="mt-0.5 size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <h2 id="runtime-tool-approval" className="font-semibold">运行时工具批准</h2>
              <p className="mt-1 text-sm text-muted-foreground">只影响会话运行时是否自动批准工具，不创建长期账号授权。偏好变更即时保存。</p>
            </div>
            <Switch checked={authorizationModeEnabled} onCheckedChange={(checked) => { void updateRuntimeApproval(checked); }} disabled={savingApproval} aria-label="自动批准运行时工具" />
          </div>
          <div className="mt-4 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>当前没有运行时批准记录查询 API，因此这里只管理批准偏好，不展示虚构的批准历史。</span>
          </div>
        </section>
      </div>
    </div>
  );
}

export function FilesStorageSection({ renderFiles }: { renderFiles?: () => ReactNode }) {
  const [tab, setTab] = useState<"files" | "storage">("files");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex gap-2" role="tablist" aria-label="文件与存储">
        <Button type="button" size="sm" variant={tab === "files" ? "default" : "outline"} onClick={() => setTab("files")}>文件</Button>
        <Button type="button" size="sm" variant={tab === "storage" ? "default" : "outline"} onClick={() => setTab("storage")}>存储用量</Button>
      </div>
      <div className="min-h-0 flex-1">{tab === "files" ? renderFiles?.() ?? null : <AttachmentStorageSection />}</div>
    </div>
  );
}
