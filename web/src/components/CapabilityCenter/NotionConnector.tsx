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
import { CapabilityDetailDrawer, CapabilitySourceBadge } from "./CatalogUi";

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
      await disconnectNotion();
      setConnection(null);
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

function NotionLogo() {
  return <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-black text-white"><BookOpenText className="size-6" /></span>;
}

export function notionMatchesCatalog(query: string, activeFilter: string, connected: boolean): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (!normalized || "notion ntn 页面 数据库".includes(normalized))
    && (activeFilter === "all" || activeFilter === "platform" || (activeFilter === "enabled" && connected));
}

export function NotionConnectorCard({ state, onOpenDetail }: { state: NotionConnectorState; onOpenDetail: () => void }) {
  const connected = state.connection?.status === "connected";
  const busy = state.loading || state.connecting || state.session?.status === "starting" || state.session?.status === "awaiting_user";
  return (
    <Card className="group cursor-pointer border-border/70 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md" onClick={onOpenDetail}>
      <CardContent className="flex min-h-36 items-start gap-4 p-5">
        <NotionLogo />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">Notion</div>
              <div className="mt-1 flex items-center gap-2"><CapabilitySourceBadge source="platform" /><span className={cn("text-xs font-medium", connected ? "text-success" : "text-muted-foreground")}>{busy ? "等待授权" : connected ? "已连接" : "未连接"}</span></div>
            </div>
            <button type="button" className={cn("flex size-8 items-center justify-center rounded-lg border", connected ? "border-transparent bg-success text-success-foreground" : "bg-muted/40 text-muted-foreground")} onClick={(event) => { event.stopPropagation(); if (connected) onOpenDetail(); else void state.start(); }} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : connected ? <Check className="size-4" /> : <Plus className="size-4" />}
            </button>
          </div>
          <p className="mt-3 line-clamp-2 text-sm leading-5 text-muted-foreground">{DESCRIPTION}</p>
          <div className="mt-3 text-xs text-muted-foreground">官方 CLI：ntn</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function NotionConnectorDrawer({ open, onOpenChange, state }: { open: boolean; onOpenChange: (open: boolean) => void; state: NotionConnectorState }) {
  const connected = state.connection?.status === "connected";
  return (
    <CapabilityDetailDrawer open={open} onOpenChange={onOpenChange} title="Notion" description={DESCRIPTION}>
      <div className="flex items-center gap-3"><NotionLogo /><div><CapabilitySourceBadge source="platform" /><div className={cn("mt-1 text-xs font-medium", connected ? "text-success" : "text-muted-foreground")}>{connected ? "已连接，运行环境可用" : "未连接"}</div></div></div>
      <div className="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">授权完成后，平台会向当前用户运行环境注入 <code>NOTION_API_TOKEN</code>，Shell、SDK 和官方 <code>ntn</code> CLI 可直接使用。</div>
      {state.session?.status === "awaiting_user" ? <div className="rounded-xl border p-3"><div className="text-sm font-medium">Notion 验证码：{state.session.userCode}</div><p className="mt-1 text-xs text-muted-foreground">请在 Notion 官方页面确认相同验证码。</p><Button className="mt-3" variant="outline" onClick={state.reopen}><ExternalLink className="mr-2 size-4" />打开授权页</Button></div> : null}
      {state.popupBlocked ? <div className="flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><TriangleAlert className="mt-0.5 size-4" />浏览器阻止了弹窗，请点击“打开授权页”。</div> : null}
      {state.error ? <div className="flex gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"><TriangleAlert className="mt-0.5 size-4" />{state.error}</div> : null}
      <div className="flex gap-2">
        {connected ? <Button variant="destructive" onClick={() => void state.disconnect()} disabled={state.connecting}>断开连接</Button> : <Button onClick={() => void state.start()} disabled={state.connecting}>{state.connecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}连接 Notion</Button>}
      </div>
    </CapabilityDetailDrawer>
  );
}
