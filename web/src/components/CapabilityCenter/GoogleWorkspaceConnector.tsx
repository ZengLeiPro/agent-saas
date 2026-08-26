import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import type { GoogleWorkspaceConnection } from "@agent/shared";
import {
  disconnectGoogleWorkspace,
  fetchGoogleWorkspaceConnection,
  setNativeConnectorRuntimeEnabled,
  startGoogleWorkspaceOAuth,
} from "@agent/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CapabilityDetailDrawer,
  CapabilitySourceBadge,
  ConnectorCatalogCard,
  CAPABILITY_SUBTLE_SURFACE,
} from "./CatalogUi";

interface GoogleWorkspaceConnectorState {
  connection: GoogleWorkspaceConnection | null;
  available: boolean;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  setRuntimeEnabled: (enabled: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useGoogleWorkspaceConnector(enabled = true): GoogleWorkspaceConnectorState {
  const [connection, setConnection] = useState<GoogleWorkspaceConnection | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(enabled);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  const load = useCallback(async () => {
    const result = await fetchGoogleWorkspaceConnection();
    setConnection(result.connection);
    setAvailable(result.available);
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    const popup = window.open("", "google-workspace-oauth", "popup,width=560,height=720");
    popupRef.current = popup;
    if (popup) {
      popup.document.write('<!doctype html><meta charset="utf-8"><title>Google Workspace 授权</title><body style="font-family:system-ui;padding:32px"><h2>正在准备 Google 官方授权</h2></body>');
      popup.document.close();
    }
    try {
      const started = await startGoogleWorkspaceOAuth();
      if (!popup) throw new Error("浏览器阻止了 Google Workspace 授权弹窗");
      popup.location.href = started.authorizationUrl;
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      setError(err instanceof Error ? err.message : "Google Workspace 授权启动失败");
      setConnecting(false);
    }
  }, []);

  const setRuntimeEnabled = useCallback(async (runtimeEnabled: boolean) => {
    setConnecting(true);
    setError(null);
    try {
      await setNativeConnectorRuntimeEnabled("google-workspace", runtimeEnabled);
      setConnection((current) => current ? { ...current, runtimeEnabled, envAvailable: runtimeEnabled } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google Workspace 状态更新失败");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const result = await disconnectGoogleWorkspace();
      setConnection(result.connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google Workspace 断开失败");
    } finally {
      setConnecting(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void load()
      .catch((err) => setError(err instanceof Error ? err.message : "Google Workspace 连接状态读取失败"))
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
      void load().catch((err) => setError(err instanceof Error ? err.message : "Google Workspace 状态刷新失败"));
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

  return { connection, available, loading, connecting, error, connect, setRuntimeEnabled, disconnect };
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
      statusLabel={busy ? "授权中" : connected ? runtimeEnabled ? "已连接" : "已暂停" : state.available ? "未连接" : "未配置"}
      statusClassName={connected && runtimeEnabled ? "text-success" : "text-muted-foreground"}
      description={DESCRIPTION}
      metadata="官方 CLI：gws"
      onOpenDetail={onOpenDetail}
      actionLabel={connected ? runtimeEnabled ? "暂停" : "恢复" : "连接"}
      actionIcon={busy ? <Loader2 className="size-4 animate-spin" /> : undefined}
      actionTone={connected && runtimeEnabled ? "success" : "default"}
      actionDisabled={busy || !state.available}
      actionTitle={!state.available ? "管理员尚未配置 Google OAuth" : undefined}
      onAction={() => {
        if (connected) void state.setRuntimeEnabled(!runtimeEnabled);
        else void state.connect();
      }}
    />
  );
}

export function GoogleWorkspaceConnectorDrawer({ open, onOpenChange, state }: { open: boolean; onOpenChange: (open: boolean) => void; state: GoogleWorkspaceConnectorState }) {
  const connected = state.connection?.status === "connected";
  const runtimeEnabled = state.connection?.runtimeEnabled ?? true;
  return (
    <CapabilityDetailDrawer open={open} onOpenChange={onOpenChange} title="Google Workspace" description={DESCRIPTION}>
      <div className="flex items-center gap-3"><GoogleWorkspaceLogo /><div><CapabilitySourceBadge source="platform" /><div className={cn("mt-1 text-xs font-medium", connected && runtimeEnabled ? "text-success" : "text-muted-foreground")}>{connected ? runtimeEnabled ? "已连接，运行环境可用" : "已暂停，授权仍保留" : state.available ? "未连接" : "管理员尚未配置 OAuth"}</div></div></div>
      {state.connection?.accountEmail ? <div className="rounded-xl p-3 text-sm ring-1 ring-border/60"><div className="text-xs text-muted-foreground">Google 账号</div><div className="mt-1 font-medium">{state.connection.accountEmail}</div></div> : null}
      <div className={cn("p-3 text-sm text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>授权后，平台按运行实时刷新 access token，并注入 <code>GOOGLE_WORKSPACE_CLI_TOKEN</code>。一个账号即可使用 Google Workspace 内容、通信、自动化与管理能力。</div>
      {state.error ? <div className="flex gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"><TriangleAlert className="mt-0.5 size-4" />{state.error}</div> : null}
      {connected ? <div className="flex gap-2"><Button variant="outline" onClick={() => void state.connect()} disabled={state.connecting || !state.available}>{state.connecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}扩展权限</Button><Button variant="destructive" onClick={() => void state.disconnect()} disabled={state.connecting}>断开连接</Button></div> : <Button onClick={() => void state.connect()} disabled={state.connecting || !state.available}>{state.connecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}连接 Google Workspace</Button>}
    </CapabilityDetailDrawer>
  );
}
