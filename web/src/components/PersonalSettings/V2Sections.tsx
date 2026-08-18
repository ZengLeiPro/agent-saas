import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { authFetch } from "@/lib/authFetch";
import { useEffectiveResources } from "@/hooks/useEffectiveResources";
import { navigateSettingsRoute } from "@/lib/urlSync";
import { EntityIcons } from "@/lib/icons";
import { governanceRoute, parseGovernanceUrl } from "@/lib/governanceNavigation";
import { isDebugModeAvailable, startGoogleWorkspaceOAuth, type GoogleWorkspaceOAuthStartResponse } from "@agent/shared";
import { governanceAccessApi, type OAuthGrantResponse, type OAuthRevocationPreview, type OAuthRevocationResult } from "@agent/shared/lib/governanceApi";
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
  const { user, updateDebugMode } = useAuth();
  const [debugMode, setDebugMode] = useState(user?.debugMode === true);
  const [debugModeSaving, setDebugModeSaving] = useState(false);
  const [debugModeError, setDebugModeError] = useState<string | null>(null);
  const debugModeAvailable = user
    ? isDebugModeAvailable(user.tenantId, user.tenantFeatures)
    : false;
  const debugModeDisabledReason = user?.tenantFeatures?.debugModeAllowed !== true
    ? "平台尚未授权，当前不能开启个人调试模式。"
    : "组织尚未开放，当前不能开启个人调试模式。";

  useEffect(() => {
    setDebugMode(user?.debugMode === true && debugModeAvailable);
  }, [debugModeAvailable, user?.debugMode]);

  const saveDebugMode = async (next: boolean) => {
    setDebugModeSaving(true);
    setDebugModeError(null);
    try {
      const response = await authFetch("/api/auth/me/debug-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debugMode: next }),
      });
      const payload = await response.json().catch(() => ({})) as { debugMode?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `保存调试模式失败（HTTP ${response.status}）`);
      }
      const effective = payload.debugMode === true;
      setDebugMode(effective);
      updateDebugMode(effective);
    } catch (cause) {
      setDebugModeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDebugModeSaving(false);
    }
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="我的权限"
        description="只展示服务端返回的有效资源与七层权限解释；前端不会本地推导或在失败时降级放行。"
        actions={<Button type="button" size="sm" variant="outline" onClick={request.retry} disabled={request.loading}>{request.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button>}
      />
      <div className="min-h-0 flex-1 space-y-6 overflow-auto pb-4">
        <section className="rounded-2xl border bg-card p-5 shadow-sm" aria-labelledby="personal-debug-mode">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="personal-debug-mode" className="font-semibold">个人调试模式</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                只影响当前账号。开启后显示思考、工具调用和技能执行细节；平台授权和组织开关均开启后才能使用。
              </p>
            </div>
            <Switch
              checked={debugModeAvailable && debugMode}
              disabled={debugModeSaving || !debugModeAvailable}
              onCheckedChange={next => void saveDebugMode(next)}
              aria-label="个人调试模式"
            />
          </div>
          {!debugModeAvailable ? <p className="mt-3 text-sm text-muted-foreground" role="note">{debugModeDisabledReason}</p> : null}
          {debugModeError ? <div className="mt-3 text-sm text-destructive" role="alert">{debugModeError}</div> : null}
        </section>
        <EffectiveResourceList resources={request.data} loading={request.loading} error={request.error} onRetry={request.retry} />
        {authoritativeExample ? <PermissionWhyPanel evaluation={authoritativeExample} /> : null}
      </div>
    </div>
  );
}

type OAuthGrantView = OAuthGrantResponse['grants'][number];
const grantStatusLabel: Record<OAuthGrantView['status'], string> = {
  active: "已连接", expired: "需重连", revoked: "已撤销", error: "需重连",
};
const approvalActionLabel: Record<OAuthGrantView['approvals'][number]['action'], string> = {
  approved: "已批准", revoked: "已撤销", expired: "已过期", refreshed: "已刷新",
};

export function ConnectionsSection() {
  const [grants, setGrants] = useState<OAuthGrantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const [revocationPreview, setRevocationPreview] = useState<{ grant: OAuthGrantView; value: OAuthRevocationPreview } | null>(null);
  const [revocationReceipt, setRevocationReceipt] = useState<OAuthRevocationResult | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [googleAuthorizationUrl, setGoogleAuthorizationUrl] = useState<string | null>(null);
  const [googleConnectPreview, setGoogleConnectPreview] = useState<GoogleWorkspaceOAuthStartResponse | null>(null);
  const googlePopup = useRef<Window | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await governanceAccessApi.listOAuthGrants();
      setGrants(response.grants);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取 OAuth Grant 失败");
      setGrants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!googlePopup.current || event.source !== googlePopup.current) return;
      const result = event.data as { type?: string; connectorId?: string; ok?: boolean; message?: string };
      if (result.type !== "connector-oauth-result" || result.connectorId !== "google-workspace") return;
      googlePopup.current = null;
      setConnectingGoogle(false);
      setGoogleAuthorizationUrl(null);
      if (!result.ok) {
        setMutationError(result.message || "Google Workspace 授权失败");
        return;
      }
      void load();
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [load]);

  const connectGoogle = useCallback(async () => {
    setConnectingGoogle(true);
    setMutationError(null);
    setGoogleAuthorizationUrl(null);
    try {
      const started = await startGoogleWorkspaceOAuth();
      const authorizationUrl = new URL(started.authorizationUrl);
      if (authorizationUrl.protocol !== "https:") throw new Error("OAuth authorization URL 必须使用 HTTPS");
      if (!started.requestedScopes.length || !started.purpose || !started.dataDestination || !started.revokeMethod) {
        throw new Error("OAuth scope 预览权威不可用");
      }
      setGoogleConnectPreview({ ...started, authorizationUrl: authorizationUrl.toString() });
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Google Workspace 授权预览失败");
    } finally {
      setConnectingGoogle(false);
    }
  }, []);

  const confirmGoogleConnect = useCallback(() => {
    if (!googleConnectPreview) return;
    const popup = window.open("", "google-workspace-governance-oauth", "popup,width=560,height=720");
    googlePopup.current = popup;
    if (!popup) {
      setGoogleAuthorizationUrl(googleConnectPreview.authorizationUrl);
      return;
    }
    popup.location.href = googleConnectPreview.authorizationUrl;
    setGoogleConnectPreview(null);
  }, [googleConnectPreview]);

  const cancelGoogleConnect = useCallback(() => {
    if (googlePopup.current && !googlePopup.current.closed) googlePopup.current.close();
    googlePopup.current = null;
    setConnectingGoogle(false);
    setGoogleAuthorizationUrl(null);
    setGoogleConnectPreview(null);
  }, []);

  const revokeGrant = useCallback(async (grant: OAuthGrantView) => {
    setRevokingGrantId(grant.grantId);
    setRevocationReceipt(null);
    setMutationError(null);
    try {
      const value = await governanceAccessApi.previewOAuthGrantRevocation(grant.grantId, "用户主动撤销长期账号授权");
      setRevocationPreview({ grant, value });
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "撤销授权预览失败");
    } finally {
      setRevokingGrantId(null);
    }
  }, []);

  const confirmRevocation = useCallback(async () => {
    if (!revocationPreview) return;
    if (Date.parse(revocationPreview.value.expiresAt) <= Date.now() || revocationPreview.value.impact.blockers.length > 0) {
      setMutationError("预览已过期或存在阻断项，请重新生成。");
      setRevocationPreview(null);
      return;
    }
    const grantId = revocationPreview.grant.grantId;
    setRevokingGrantId(grantId);
    setMutationError(null);
    try {
      const receipt = await governanceAccessApi.revokeOAuthGrant(grantId, {
        reason: "用户主动撤销长期账号授权", previewId: revocationPreview.value.previewId,
        baselineDigest: revocationPreview.value.baselineDigest, expiresAt: revocationPreview.value.expiresAt,
      });
      setRevocationReceipt(receipt);
      setRevocationPreview(null);
      await load();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "撤销授权失败");
    } finally {
      setRevokingGrantId(null);
    }
  }, [load, revocationPreview]);

  const googleGrant = grants.find(grant => grant.provider === "google" && grant.status !== "revoked");
  const hasActiveGoogleGrant = googleGrant?.status === "active";
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader title="连接与授权" description="长期账号授权与单次运行时工具批准是两类独立能力，不互相冒充。" />
      <div className="min-h-0 flex-1 space-y-5 overflow-auto pb-4">
        <section className="rounded-2xl border bg-card p-5 shadow-sm" aria-labelledby="long-term-authorizations">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <h2 id="long-term-authorizations" className="font-semibold">长期账号授权</h2>
              <p className="mt-1 text-sm text-muted-foreground">仅展示治理 OAuth Grant 与批准记录；Token、Secret 和外部账号标识不进入页面 DTO。</p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => { void load(); }} disabled={loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border p-3 text-sm">
            <div className="min-w-0 flex-1"><div className="font-medium">Google Workspace</div><div className="text-xs text-muted-foreground">{hasActiveGoogleGrant ? "已存在受治理的长期授权" : googleGrant ? `当前状态：${grantStatusLabel[googleGrant.status]}，请重新连接` : "通过 Google 官方页面授权；回调成功后重新读取 OAuth Grant。"}</div></div>
            {!hasActiveGoogleGrant ? <Button type="button" size="sm" onClick={() => { void connectGoogle(); }} disabled={connectingGoogle}>{connectingGoogle ? <Loader2 className="size-4 animate-spin" /> : null}{googleGrant ? "重新连接" : "连接"}</Button> : null}
            {connectingGoogle ? <Button type="button" size="sm" variant="outline" onClick={cancelGoogleConnect}>取消授权</Button> : null}
          </div>
          {googleConnectPreview ? <div className="mt-3 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm" aria-labelledby="google-connect-preview-title">
            <div id="google-connect-preview-title" className="font-semibold">确认 Google Workspace 授权范围</div>
            <div>{googleConnectPreview.purpose}</div>
            <div className="text-xs"><strong>风险：</strong>高影响长期授权 · <strong>数据去向：</strong>{googleConnectPreview.dataDestination}</div>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{googleConnectPreview.requestedScopes.map(scope => <li key={scope}>{scope}</li>)}</ul>
            <div className="text-xs text-muted-foreground">{googleConnectPreview.revokeMethod}。授权信息由 Google 展示并确认；Token 不进入治理页面。</div>
            <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="outline" onClick={cancelGoogleConnect}>取消</Button><Button type="button" size="sm" onClick={confirmGoogleConnect}>前往 Google 授权</Button></div>
          </div> : null}
          {googleAuthorizationUrl ? <div className="mt-3 rounded-lg border border-amber-500/30 p-3 text-sm" role="alert">浏览器阻止了授权弹窗。<a className="ml-1 underline" href={googleAuthorizationUrl}>在当前页继续授权</a></div> : null}
          {error ? <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</div> : null}
          {mutationError ? <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{mutationError}</div> : null}
          {revocationPreview ? (
            <div className="mt-4 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm" role="region" aria-labelledby="oauth-revoke-title">
              <div id="oauth-revoke-title" className="font-semibold">确认撤销 {revocationPreview.grant.connectorId ?? revocationPreview.grant.provider}</div>
              <div>立即阻止新 Run 使用该授权；外部撤销失败时进入后台重试，不会恢复本地调用。</div>
              <div className="grid gap-1 text-xs text-muted-foreground">
                <span>版本：v{revocationPreview.value.impact.currentVersion} → v{revocationPreview.value.impact.nextVersion}</span>
                <span>生效方式：{revocationPreview.value.impact.effectiveMode} · {revocationPreview.value.impact.reversible ? "可逆" : "不可逆"}</span>
                <span>基线：{revocationPreview.value.baselineDigest.slice(0, 12)}… · 有效期至 {new Date(revocationPreview.value.expiresAt).toLocaleString()}</span>
                <span>受影响 Agent：{revocationPreview.value.impact.affectedAgents.join("、") || "权威未返回具体对象"}</span>
                <span>受影响自动化：{revocationPreview.value.impact.affectedAutomations.join("、") || "权威未返回具体对象"}</span>
              </div>
              {revocationPreview.value.impact.warnings.length ? <div className="rounded-lg border border-amber-500/30 p-2 text-xs">影响清单尚不完整：{revocationPreview.value.impact.warnings.join("、")}</div> : null}
              {revocationPreview.value.impact.blockers.length ? <div className="rounded-lg border border-destructive/30 p-2 text-xs text-destructive">阻断：{revocationPreview.value.impact.blockers.join("、")}</div> : null}
              <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setRevocationPreview(null)} disabled={Boolean(revokingGrantId)}>取消</Button><Button type="button" variant="destructive" onClick={() => { void confirmRevocation(); }} disabled={Boolean(revokingGrantId) || revocationPreview.value.impact.blockers.length > 0 || Date.parse(revocationPreview.value.expiresAt) <= Date.now()}>确认撤销</Button></div>
            </div>
          ) : null}
          {revocationReceipt ? (
            <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm" role="status">
              <div className="font-medium">OAuth 授权撤销回执</div>
              <div className="mt-1 text-xs text-muted-foreground">
                状态：{revocationReceipt.status} · Change ID：{revocationReceipt.changeId} · Audit ID：{revocationReceipt.auditId}
                {revocationReceipt.auditCompletion === "pending" ? " · 审计终态：pending" : ""}
              </div>
            </div>
          ) : null}
          {!loading && !error ? (
            grants.length ? (
              <ul className="mt-4 divide-y rounded-xl border">
                {grants.map((grant) => (
                  <li key={grant.grantId} className="space-y-3 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3"><div><div className="font-medium">{grant.connectorId ?? grant.provider}</div><div className="text-xs text-muted-foreground">{grant.provider} · Grant v{grant.version}</div></div><div className="flex items-center gap-2"><span className="rounded-full bg-muted px-2 py-1 text-xs">{grantStatusLabel[grant.status]}</span>{grant.status === "active" || grant.status === "error" ? <Button type="button" size="sm" variant="outline" onClick={() => { void revokeGrant(grant); }} disabled={revokingGrantId === grant.grantId}>{revokingGrantId === grant.grantId ? <Loader2 className="size-4 animate-spin" /> : grant.status === "error" ? "重试撤销" : "撤销授权"}</Button> : null}</div></div>
                    <div className="text-xs text-muted-foreground">范围：{grant.scopeSummary.join("、") || "未声明"} · 批准于 {new Date(grant.approvedAt).toLocaleString()}</div>
                    {grant.approvals.length ? <ul className="space-y-1 rounded-lg bg-muted/50 p-2 text-xs">{grant.approvals.map(approval => <li key={approval.approvalId}>{approvalActionLabel[approval.action]} · {approval.purpose} · {new Date(approval.occurredAt).toLocaleString()}</li>)}</ul> : null}
                  </li>
                ))}
              </ul>
            ) : <div className="mt-4 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">没有治理 OAuth Grant。连接入口在完成 Entitlement、Assignment 与 scope 预检合同前保持关闭，不会回退到旧 OAuth 写入口。</div>
          ) : null}
        </section>

        <section className="rounded-2xl border bg-card p-5 shadow-sm" aria-labelledby="runtime-tool-approval">
          <div className="flex items-start gap-3">
            <EntityIcons.admin className="mt-0.5 size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <h2 id="runtime-tool-approval" className="font-semibold">运行时工具批准</h2>
              <p className="mt-1 text-sm text-muted-foreground">当前权威 Runtime Approval API 尚未提供，所有工具保持“每次询问”；旧全局偏好开关不再作为治理批准能力。</p>
            </div>
            <span className="rounded-full border bg-muted px-3 py-1 text-xs">每次询问</span>
          </div>
          <div className="mt-4 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>需等待后端按工具类别返回上层策略、允许范围、风险、版本和 allowedActions 后才能开启自动批准。</span>
          </div>
        </section>
      </div>
    </div>
  );
}

export function FilesStorageSection({ renderFiles }: { renderFiles?: () => ReactNode }) {
  return (
    <Tabs defaultValue="files" className="flex h-full min-h-0 flex-col">
      <TabsList className="mb-3 w-fit" aria-label="文件与存储">
        <TabsTrigger value="files">文件</TabsTrigger>
        <TabsTrigger value="storage">存储用量</TabsTrigger>
      </TabsList>
      <TabsContent value="files" className="min-h-0 flex-1">{renderFiles?.() ?? null}</TabsContent>
      <TabsContent value="storage" className="min-h-0 flex-1"><AttachmentStorageSection /></TabsContent>
    </Tabs>
  );
}
