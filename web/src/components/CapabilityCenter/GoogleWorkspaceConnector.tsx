import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, TriangleAlert } from "lucide-react";
import type { GoogleWorkspaceConnection } from "@agent/shared";
import {
  disconnectGoogleWorkspace,
  fetchGoogleWorkspaceConnection,
  startGoogleWorkspaceOAuth,
} from "@agent/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  CapabilityDetailDrawer,
  CapabilitySourceBadge,
  CAPABILITY_SUBTLE_SURFACE,
  CAPABILITY_SURFACE,
  CAPABILITY_SURFACE_HOVER,
} from "./CatalogUi";

interface GoogleWorkspaceConnectorState {
  connection: GoogleWorkspaceConnection | null;
  available: boolean;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
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

  const disconnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await disconnectGoogleWorkspace();
      setConnection(null);
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

  return { connection, available, loading, connecting, error, connect, disconnect };
}

const DESCRIPTION = "使用 Google 官方 gws CLI 操作 Gmail、Drive、Calendar、Chat 和 Contacts。";

function GoogleWorkspaceLogo() {
  return <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-xl font-bold text-blue-600 ring-1 ring-inset ring-black/10">G</span>;
}

export function googleWorkspaceMatchesCatalog(query: string, activeFilter: string, connected: boolean): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (!normalized || "google workspace gws gmail drive calendar chat contacts".includes(normalized))
    && (activeFilter === "all" || activeFilter === "platform" || (activeFilter === "enabled" && connected));
}

export function GoogleWorkspaceConnectorCard({ state, onOpenDetail }: { state: GoogleWorkspaceConnectorState; onOpenDetail: () => void }) {
  const connected = state.connection?.status === "connected";
  const busy = state.loading || state.connecting;
  return (
    <Card className={cn("group cursor-pointer border-0 shadow-none", CAPABILITY_SURFACE, CAPABILITY_SURFACE_HOVER)} onClick={onOpenDetail}>
      <CardContent className="flex min-h-36 items-start gap-4 p-5">
        <GoogleWorkspaceLogo />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div><div className="font-semibold">Google Workspace</div><div className="mt-1 flex items-center gap-2"><CapabilitySourceBadge source="platform" /><span className={cn("text-xs font-medium", connected ? "text-success" : "text-muted-foreground")}>{busy ? "授权中" : connected ? "已连接" : state.available ? "未连接" : "未配置"}</span></div></div>
            <button type="button" className={cn("flex size-8 items-center justify-center rounded-lg border", connected ? "border-transparent bg-success text-success-foreground" : "bg-muted/40 text-muted-foreground")} onClick={(event) => { event.stopPropagation(); if (connected) onOpenDetail(); else void state.connect(); }} disabled={busy || !state.available}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : connected ? <Check className="size-4" /> : <Plus className="size-4" />}
            </button>
          </div>
          <p className="mt-3 line-clamp-2 text-sm leading-5 text-muted-foreground">{DESCRIPTION}</p>
          <div className="mt-3 text-xs text-muted-foreground">官方 CLI：gws</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function GoogleWorkspaceConnectorDrawer({ open, onOpenChange, state }: { open: boolean; onOpenChange: (open: boolean) => void; state: GoogleWorkspaceConnectorState }) {
  const connected = state.connection?.status === "connected";
  return (
    <CapabilityDetailDrawer open={open} onOpenChange={onOpenChange} title="Google Workspace" description={DESCRIPTION}>
      <div className="flex items-center gap-3"><GoogleWorkspaceLogo /><div><CapabilitySourceBadge source="platform" /><div className={cn("mt-1 text-xs font-medium", connected ? "text-success" : "text-muted-foreground")}>{connected ? "已连接，运行环境可用" : state.available ? "未连接" : "管理员尚未配置 OAuth"}</div></div></div>
      {state.connection?.accountEmail ? <div className="rounded-xl p-3 text-sm ring-1 ring-border/60"><div className="text-xs text-muted-foreground">Google 账号</div><div className="mt-1 font-medium">{state.connection.accountEmail}</div></div> : null}
      <div className={cn("p-3 text-sm text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>授权后，平台按运行实时刷新 access token，并注入 <code>GOOGLE_WORKSPACE_CLI_TOKEN</code>。一个账号即可使用 Gmail、Drive、Calendar、Chat 与 Contacts。</div>
      {state.error ? <div className="flex gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"><TriangleAlert className="mt-0.5 size-4" />{state.error}</div> : null}
      {connected ? <Button variant="destructive" onClick={() => void state.disconnect()} disabled={state.connecting}>断开连接</Button> : <Button onClick={() => void state.connect()} disabled={state.connecting || !state.available}>{state.connecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}连接 Google Workspace</Button>}
    </CapabilityDetailDrawer>
  );
}
