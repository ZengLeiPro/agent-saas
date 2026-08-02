import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpenText, Check, ExternalLink, Loader2, Plus, TriangleAlert } from "lucide-react";
import type { ConnectorAuthSession, NotionConnection } from "@agent/shared";
import {
  disconnectNotion,
  fetchNotionAuthSession,
  fetchNotionConnection,
  startNotionAuthSession,
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

interface NotionConnectorState {
  connection: NotionConnection | null;
  session: ConnectorAuthSession | null;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  popupBlocked: boolean;
  start: () => Promise<void>;
  disconnect: () => Promise<void>;
  reopen: () => void;
}

export function useNotionConnector(enabled = true): NotionConnectorState {
  const [connection, setConnection] = useState<NotionConnection | null>(null);
  const [session, setSession] = useState<ConnectorAuthSession | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const openedUrlRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const [connectionResult, sessionResult] = await Promise.all([
      fetchNotionConnection(),
      fetchNotionAuthSession(),
    ]);
    setConnection(connectionResult.connection);
    setSession(sessionResult.session);
  }, []);

  const reopen = useCallback(() => {
    const url = session?.authorizationUrl;
    if (!url) return;
    const popup = popupRef.current && !popupRef.current.closed
      ? popupRef.current
      : window.open("", "_blank");
    if (!popup) {
      setPopupBlocked(true);
      return;
    }
    popup.opener = null;
    popup.location.href = url;
    popupRef.current = popup;
    openedUrlRef.current = url;
    setPopupBlocked(false);
  }, [session?.authorizationUrl]);

  const start = useCallback(async () => {
    setConnecting(true);
    setError(null);
    setPopupBlocked(false);
    const popup = window.open("", "_blank");
    if (popup) {
      popup.opener = null;
      popup.document.write('<!doctype html><meta charset="utf-8"><title>Notion 授权</title><body style="font-family:system-ui;padding:32px"><h2>正在准备 Notion 官方授权</h2><p>请稍候，此窗口将自动跳转。</p></body>');
      popup.document.close();
      popupRef.current = popup;
    } else {
      popupRef.current = null;
      setPopupBlocked(true);
    }
    try {
      const result = await startNotionAuthSession();
      setSession(result.session);
      if (result.session?.authorizationUrl && popup) {
        popup.location.href = result.session.authorizationUrl;
        openedUrlRef.current = result.session.authorizationUrl;
      }
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      setError(err instanceof Error ? err.message : "Notion 授权启动失败");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const result = await disconnectNotion();
      setConnection(result.connection ?? null);
      setSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Notion 断开失败");
    } finally {
      setConnecting(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void load()
      .catch((err) => setError(err instanceof Error ? err.message : "Notion 连接状态读取失败"))
      .finally(() => setLoading(false));
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || (session?.status !== "starting" && session?.status !== "awaiting_user")) return;
    const timer = window.setInterval(() => {
      void fetchNotionAuthSession().then((result) => {
        setSession(result.session);
        if (result.session?.status === "connected") {
          void fetchNotionConnection().then((connectionResult) => setConnection(connectionResult.connection));
        }
      }).catch((err) => setError(err instanceof Error ? err.message : "Notion 授权状态读取失败"));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [enabled, session?.status]);

  useEffect(() => {
    const url = session?.authorizationUrl;
    if (session?.status !== "awaiting_user" || !url || openedUrlRef.current === url) return;
    const popup = popupRef.current;
    if (!popup || popup.closed) {
      setPopupBlocked(true);
      return;
    }
    popup.location.href = url;
    openedUrlRef.current = url;
  }, [session]);

  return { connection, session, loading, connecting, error, popupBlocked, start, disconnect, reopen };
}

const DESCRIPTION = "使用 Notion 官方 ntn CLI 搜索、读取和维护页面、数据库与评论。";
const LOCAL_DISCONNECT_HELP = "断开仅移除本平台保存的凭据，不会在 Notion 远程撤销。如需彻底撤销，请在 Notion 中移除授权/令牌。";

function NotionLogo() {
  return <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-black text-white"><BookOpenText className="size-6" /></span>;
}

function statusLabel(status: NotionConnection["status"] | undefined): string {
  if (status === "connected") return "已验证";
  if (status === "invalid") return "授权已失效";
  if (status === "unavailable") return "暂时无法验证";
  return "未连接";
}

export function notionMatchesCatalog(query: string, activeFilter: string, connected: boolean): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (!normalized || "notion ntn 页面 数据库".includes(normalized))
    && (activeFilter === "all" || activeFilter === "platform" || (activeFilter === "enabled" && connected));
}

export function NotionConnectorCard({ state, onOpenDetail }: { state: NotionConnectorState; onOpenDetail: () => void }) {
  const status = state.connection?.status;
  const linked = Boolean(status && status !== "disconnected");
  const connected = status === "connected";
  const busy = state.loading || state.connecting || state.session?.status === "starting" || state.session?.status === "awaiting_user";
  return (
    <Card className={cn("group cursor-pointer border-0 shadow-none", CAPABILITY_SURFACE, CAPABILITY_SURFACE_HOVER)} onClick={onOpenDetail}>
      <CardContent className="flex min-h-36 items-start gap-4 p-5">
        <NotionLogo />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">Notion</div>
              <div className="mt-1 flex items-center gap-2"><CapabilitySourceBadge source="platform" /><span className={cn("text-xs font-medium", connected ? "text-success" : status === "invalid" ? "text-destructive" : "text-muted-foreground")}>{busy ? "等待授权" : statusLabel(status)}</span></div>
            </div>
            <button type="button" className={cn("flex size-8 items-center justify-center rounded-lg border", linked ? "border-transparent bg-success text-success-foreground" : "bg-muted/40 text-muted-foreground")} onClick={(event) => { event.stopPropagation(); if (linked) onOpenDetail(); else void state.start(); }} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : linked ? <Check className="size-4" /> : <Plus className="size-4" />}
            </button>
          </div>
          <p className="mt-3 line-clamp-2 text-sm leading-5 text-muted-foreground">{DESCRIPTION}</p>
          <div className="mt-3 truncate text-xs text-muted-foreground">{state.connection?.workspaceName ? `工作区：${state.connection.workspaceName}` : "官方 CLI：ntn"}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function NotionConnectorDrawer({ open, onOpenChange, state }: { open: boolean; onOpenChange: (open: boolean) => void; state: NotionConnectorState }) {
  const status = state.connection?.status;
  const linked = Boolean(status && status !== "disconnected");
  const connected = status === "connected";
  const identity = state.connection?.identity;
  return (
    <CapabilityDetailDrawer open={open} onOpenChange={onOpenChange} title="Notion" description={DESCRIPTION}>
      <div className="flex items-center gap-3"><NotionLogo /><div><CapabilitySourceBadge source="platform" /><div className={cn("mt-1 text-xs font-medium", connected ? "text-success" : status === "invalid" ? "text-destructive" : "text-muted-foreground")}>{statusLabel(status)}{connected ? "，运行环境可用" : ""}</div></div></div>
      <div className={cn("space-y-1 p-3 text-sm text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>
        {state.connection?.workspaceName ? <div>工作区：<span className="text-foreground">{state.connection.workspaceName}</span>{state.connection.workspaceId ? <span className="ml-1 text-xs">({state.connection.workspaceId})</span> : null}</div> : null}
        {identity ? <div>身份：<span className="text-foreground">{identity.name || identity.email || identity.id}</span> · {identity.type === "person" ? "Person" : "Bot"}</div> : null}
        {state.connection?.verifiedAt ? <div className="text-xs">最近验证：{new Date(state.connection.verifiedAt).toLocaleString()}</div> : null}
        {state.connection?.verificationMessage ? <div className="text-xs">{state.connection.verificationMessage}</div> : null}
        {!linked ? <div>授权完成后，平台会向当前用户运行环境注入 <code>NOTION_API_TOKEN</code>。</div> : null}
      </div>
      {state.session?.status === "awaiting_user" ? <div className="rounded-xl p-3 ring-1 ring-border/60"><div className="text-sm font-medium">Notion 验证码：{state.session.userCode}</div><p className="mt-1 text-xs text-muted-foreground">请在 Notion 官方页面确认相同验证码。</p><Button className="mt-3" variant="outline" onClick={state.reopen}><ExternalLink className="mr-2 size-4" />打开授权页</Button></div> : null}
      {state.popupBlocked ? <div className="flex gap-2 rounded-xl bg-warning-subtle p-3 text-sm text-warning-ink"><TriangleAlert className="mt-0.5 size-4" />浏览器阻止了弹窗，请点击“打开授权页”。</div> : null}
      {state.error ? <div className="flex gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"><TriangleAlert className="mt-0.5 size-4" />{state.error}</div> : null}
      {linked ? <div className="flex gap-2 rounded-xl bg-warning-subtle p-3 text-sm text-warning-ink"><TriangleAlert className="mt-0.5 size-4 shrink-0" />{LOCAL_DISCONNECT_HELP}</div> : null}
      <div className="flex gap-2">
        {linked ? <><Button variant="destructive" onClick={() => void state.disconnect()} disabled={state.connecting}>仅在本地断开</Button>{status === "invalid" ? <Button onClick={() => void state.start()} disabled={state.connecting}>重新连接</Button> : null}</> : <Button onClick={() => void state.start()} disabled={state.connecting}>{state.connecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}连接 Notion</Button>}
      </div>
    </CapabilityDetailDrawer>
  );
}
