import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import type { GoogleWorkspaceConnection, GoogleWorkspaceOAuthStartResponse } from "@agent/shared";
import { disconnectGoogleWorkspace, fetchGoogleWorkspaceConnection, setNativeConnectorRuntimeEnabled, startGoogleWorkspaceOAuth } from "@agent/shared";
import { governanceAccessApi, type OAuthGrantResponse, type OAuthRevocationPreview } from "@agent/shared/lib/governanceApi";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CapabilityDetailDrawer, CapabilitySourceBadge, ConnectorCatalogCard, CAPABILITY_SUBTLE_SURFACE } from "./CatalogUi";

type OAuthGrant = OAuthGrantResponse["grants"][number];
type RevocationItem = { grant: OAuthGrant; preview: OAuthRevocationPreview };

interface GoogleWorkspaceConnectorState {
  connection: GoogleWorkspaceConnection | null;
  available: boolean;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  grants: OAuthGrant[];
  authorizationPreview: GoogleWorkspaceOAuthStartResponse | null;
  authorizationUrl: string | null;
  revocationItems: RevocationItem[] | null;
  legacyDisconnectPending: boolean;
  connect: () => Promise<void>;
  confirmConnect: () => void;
  cancelConnect: () => void;
  prepareDisconnect: () => Promise<void>;
  confirmDisconnect: () => Promise<void>;
  cancelDisconnect: () => void;
  setRuntimeEnabled: (enabled: boolean) => Promise<void>;
}

function activeGoogleGrants(grants: OAuthGrant[]): OAuthGrant[] {
  return grants.filter((grant) => grant.provider === "google"
    && grant.connectorId === "google-workspace"
    && (grant.status === "active" || grant.status === "error"));
}

export function useGoogleWorkspaceConnector(enabled = true): GoogleWorkspaceConnectorState {
  const [connection, setConnection] = useState<GoogleWorkspaceConnection | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(enabled);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grants, setGrants] = useState<OAuthGrant[]>([]);
  const [authorizationPreview, setAuthorizationPreview] = useState<GoogleWorkspaceOAuthStartResponse | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [revocationItems, setRevocationItems] = useState<RevocationItem[] | null>(null);
  const [legacyDisconnectPending, setLegacyDisconnectPending] = useState(false);
  const popupRef = useRef<Window | null>(null);

  const load = useCallback(async () => {
    const [connectionResult, grantResult] = await Promise.all([
      fetchGoogleWorkspaceConnection(),
      governanceAccessApi.listOAuthGrants(),
    ]);
    setConnection(connectionResult.connection);
    setAvailable(connectionResult.available);
    setGrants(activeGoogleGrants(grantResult.grants));
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    setAuthorizationUrl(null);
    try {
      const started = await startGoogleWorkspaceOAuth();
      const url = new URL(started.authorizationUrl);
      if (url.protocol !== "https:") throw new Error("OAuth authorization URL 必须使用 HTTPS");
      if (!started.requestedScopes.length || !started.purpose || !started.dataDestination || !started.revokeMethod) {
        throw new Error("暂时无法确认 Google Workspace 授权范围");
      }
      setAuthorizationPreview({ ...started, authorizationUrl: url.toString() });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Google Workspace 授权启动失败");
    } finally {
      setConnecting(false);
    }
  }, []);

  const confirmConnect = useCallback(() => {
    if (!authorizationPreview) return;
    const popup = window.open("", "google-workspace-oauth", "popup,width=560,height=720");
    popupRef.current = popup;
    if (!popup) {
      setAuthorizationUrl(authorizationPreview.authorizationUrl);
      return;
    }
    popup.location.href = authorizationPreview.authorizationUrl;
    setAuthorizationPreview(null);
    setConnecting(true);
  }, [authorizationPreview]);

  const cancelConnect = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    popupRef.current = null;
    setAuthorizationPreview(null);
    setAuthorizationUrl(null);
    setConnecting(false);
  }, []);

  const prepareDisconnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const current = await governanceAccessApi.listOAuthGrants();
      const currentGrants = activeGoogleGrants(current.grants);
      if (!currentGrants.length) {
        setLegacyDisconnectPending(true);
        return;
      }
      const previews = await Promise.all(currentGrants.map(async (grant) => ({
        grant,
        preview: await governanceAccessApi.previewOAuthGrantRevocation(grant.grantId, "用户主动断开 Google Workspace"),
      })));
      setGrants(currentGrants);
      setRevocationItems(previews);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Google Workspace 撤销预览失败");
    } finally {
      setConnecting(false);
    }
  }, []);

  const confirmDisconnect = useCallback(async () => {
    if (legacyDisconnectPending) {
      setConnecting(true);
      setError(null);
      try {
        const result = await disconnectGoogleWorkspace();
        setConnection(result.connection);
        setLegacyDisconnectPending(false);
        await load();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Google Workspace 断开失败");
      } finally {
        setConnecting(false);
      }
      return;
    }
    if (!revocationItems?.length) return;
    if (revocationItems.some(({ preview }) => Date.parse(preview.expiresAt) <= Date.now()
      || preview.impact.blockers.length > 0)) {
      setError("撤销确认已过期或存在阻断项，请重新确认");
      setRevocationItems(null);
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      for (const { grant, preview } of revocationItems) {
        await governanceAccessApi.revokeOAuthGrant(grant.grantId, {
          reason: "用户主动断开 Google Workspace",
          previewId: preview.previewId,
          baselineDigest: preview.baselineDigest,
          expiresAt: preview.expiresAt,
        });
      }
      setRevocationItems(null);
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Google Workspace 断开失败");
    } finally {
      setConnecting(false);
    }
  }, [legacyDisconnectPending, load, revocationItems]);

  const cancelDisconnect = useCallback(() => {
    setRevocationItems(null);
    setLegacyDisconnectPending(false);
  }, []);

  const setRuntimeEnabled = useCallback(async (runtimeEnabled: boolean) => {
    setConnecting(true);
    setError(null);
    try {
      await setNativeConnectorRuntimeEnabled("google-workspace", runtimeEnabled);
      setConnection((current) => current ? { ...current, runtimeEnabled, envAvailable: runtimeEnabled } : current);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Google Workspace 状态更新失败");
    } finally {
      setConnecting(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void load()
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Google Workspace 连接状态读取失败"))
      .finally(() => setLoading(false));
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const listener = (event: MessageEvent) => {
      if (!popupRef.current || event.source !== popupRef.current) return;
      const data = event.data as { type?: string; connectorId?: string; ok?: boolean; message?: string };
      if (data.type !== "connector-oauth-result" || data.connectorId !== "google-workspace") return;
      popupRef.current = null;
      setConnecting(false);
      if (!data.ok) {
        setError(data.message || "Google Workspace 授权失败");
        return;
      }
      void load().catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Google Workspace 状态刷新失败"));
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || !connecting || !popupRef.current) return;
    const timer = window.setInterval(() => {
      if (!popupRef.current?.closed) return;
      popupRef.current = null;
      setConnecting(false);
    }, 500);
    return () => window.clearInterval(timer);
  }, [connecting, enabled]);

  return { connection, available, loading, connecting, error, grants, authorizationPreview, authorizationUrl, revocationItems, legacyDisconnectPending, connect, confirmConnect, cancelConnect, prepareDisconnect, confirmDisconnect, cancelDisconnect, setRuntimeEnabled };
}

const DESCRIPTION = "使用 Google 官方 gws CLI 操作 Gmail、Drive、Calendar、文档、表格、Chat、Meet、联系人及自动化能力。";

function GoogleWorkspaceLogo() {
  return <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-xl font-bold text-blue-600 ring-1 ring-inset ring-black/10">G</span>;
}

export function googleWorkspaceMatchesCatalog(query: string, activeFilter: string, connected: boolean): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (!normalized || "google workspace gws gmail drive calendar docs sheets slides tasks forms keep meet script classroom chat contacts".includes(normalized))
    && (activeFilter === "all" || activeFilter === "platform" || (activeFilter === "enabled" && connected));
}

export function GoogleWorkspaceConnectorCard({ state, onOpenDetail }: { state: GoogleWorkspaceConnectorState; onOpenDetail: () => void }) {
  const connected = state.connection?.status === "connected";
  const runtimeEnabled = state.connection?.runtimeEnabled ?? true;
  const busy = state.loading || state.connecting;
  return (
    <ConnectorCatalogCard
      name="Google Workspace"
      logo={<GoogleWorkspaceLogo />}
      source="platform"
      statusLabel={busy ? "处理中" : connected ? runtimeEnabled ? "已连接" : "已暂停" : state.available ? "未连接" : "未配置"}
      statusClassName={connected && runtimeEnabled ? "text-success" : "text-muted-foreground"}
      description={DESCRIPTION}
      metadata="官方 CLI：gws"
      onOpenDetail={onOpenDetail}
      actionLabel={connected ? runtimeEnabled ? "暂停" : "恢复" : "连接"}
      actionIcon={busy ? <Loader2 className="size-4 animate-spin" /> : undefined}
      actionTone={connected && runtimeEnabled ? "success" : "default"}
      actionDisabled={busy || !state.available}
      actionTitle={!state.available ? "管理员尚未配置 Google OAuth" : undefined}
      onAction={() => { if (connected) void state.setRuntimeEnabled(!runtimeEnabled); else onOpenDetail(); }}
    />
  );
}

export function GoogleWorkspaceConnectorDrawer({ open, onOpenChange, state }: { open: boolean; onOpenChange: (open: boolean) => void; state: GoogleWorkspaceConnectorState }) {
  const connected = state.connection?.status === "connected";
  const runtimeEnabled = state.connection?.runtimeEnabled ?? true;
  const scopes = [...new Set(state.grants.flatMap((grant) => grant.scopeSummary))];
  const blockers = state.revocationItems?.flatMap(({ preview }) => preview.impact.blockers) ?? [];
  return (
    <CapabilityDetailDrawer open={open} onOpenChange={onOpenChange} title="Google Workspace" description={DESCRIPTION}>
      <div className="flex items-center gap-3"><GoogleWorkspaceLogo /><div><CapabilitySourceBadge source="platform" /><div className={cn("mt-1 text-xs font-medium", connected && runtimeEnabled ? "text-success" : "text-muted-foreground")}>{connected ? runtimeEnabled ? "已连接，运行环境可用" : "已暂停，授权仍保留" : state.available ? "未连接" : "管理员尚未配置 OAuth"}</div></div></div>
      {state.connection?.accountEmail ? <div className="rounded-xl p-3 text-sm ring-1 ring-border/60"><div className="text-xs text-muted-foreground">Google 账号</div><div className="mt-1 font-medium">{state.connection.accountEmail}</div></div> : null}
      <div className={cn("p-3 text-sm text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>连接后，Agent 可以在你的授权范围内使用 Google Workspace。你可以随时暂停使用、扩展权限或断开连接。</div>
      {scopes.length ? <div className="rounded-xl border p-3 text-sm"><div className="font-medium">当前授权范围</div><div className="mt-2 flex flex-wrap gap-1.5">{scopes.map((scope) => <span key={scope} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{scope}</span>)}</div></div> : null}
      {state.authorizationPreview ? <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm" aria-labelledby="google-authorization-preview"><div id="google-authorization-preview" className="font-semibold">确认授权范围</div><div>{state.authorizationPreview.purpose}</div><div className="text-xs text-muted-foreground">数据去向：{state.authorizationPreview.dataDestination}</div><ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{state.authorizationPreview.requestedScopes.map((scope) => <li key={scope}>{scope}</li>)}</ul><div className="text-xs text-muted-foreground">{state.authorizationPreview.revokeMethod}</div><div className="flex justify-end gap-2"><Button variant="outline" onClick={state.cancelConnect}>取消</Button><Button onClick={state.confirmConnect}>前往 Google 授权</Button></div></div> : null}
      {state.authorizationUrl ? <div className="rounded-lg border border-amber-500/30 p-3 text-sm" role="alert">浏览器阻止了授权弹窗。<a className="ml-1 underline" href={state.authorizationUrl}>在当前页继续授权</a></div> : null}
      {state.revocationItems || state.legacyDisconnectPending ? <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm" aria-labelledby="google-revocation-preview"><div id="google-revocation-preview" className="font-semibold">确认断开 Google Workspace</div><div>断开后，新的 Agent 任务将不能继续使用此 Google 账号。</div>{blockers.length ? <div className="rounded-lg border border-destructive/30 p-2 text-destructive">暂时无法断开：{blockers.join("；")}</div> : null}<div className="flex justify-end gap-2"><Button variant="outline" onClick={state.cancelDisconnect}>取消</Button><Button variant="destructive" onClick={() => { void state.confirmDisconnect(); }} disabled={Boolean(blockers.length) || state.connecting}>确认断开</Button></div></div> : null}
      {state.error ? <div className="flex gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive" role="alert"><TriangleAlert className="mt-0.5 size-4" />{state.error}</div> : null}
      {!state.authorizationPreview && !state.revocationItems && !state.legacyDisconnectPending ? connected ? <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { void state.connect(); }} disabled={state.connecting || !state.available}>{state.connecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}扩展权限</Button><Button variant="destructive" onClick={() => { void state.prepareDisconnect(); }} disabled={state.connecting}>断开连接</Button></div> : <Button onClick={() => { void state.connect(); }} disabled={state.connecting || !state.available}>{state.connecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}连接 Google Workspace</Button> : null}
    </CapabilityDetailDrawer>
  );
}
