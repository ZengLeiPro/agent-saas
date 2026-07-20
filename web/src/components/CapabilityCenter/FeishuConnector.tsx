/** 飞书官方 lark-cli 连接器；与 MCP 目录同 grid 展示，但拥有独立授权/保活数据流。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleCheck, ExternalLink, Loader2, Plus, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";
import { cn } from "@/lib/utils";
import { CapabilityDetailDrawer, CapabilitySourceBadge } from "./CatalogUi";
import { writeFeishuAuthorizingPopup } from "./feishuAuthorizingPopup";

export interface FeishuConnectionView {
  profileId: string;
  userName: string | null;
  status: "pending" | "connected" | "error" | "disconnected";
  authenticated: boolean | null;
  verified: boolean | null;
  refreshExpiresAt: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  message: string;
}

export interface FeishuAuthSessionView {
  sessionId: string;
  status: "starting" | "awaiting_user" | "connected" | "failed" | "expired";
  authorizationUrl: string | null;
  expiresAt: string;
  message: string;
}

export interface FeishuConnectionsState {
  connections: FeishuConnectionView[];
  loading: boolean;
  error: string | null;
  authSession: FeishuAuthSessionView | null;
  authError: string | null;
  authServiceUnavailable: boolean;
  connecting: boolean;
  popupBlocked: boolean;
  authInProgress: boolean;
  needsReconnect: boolean;
  hasConnected: boolean;
  connectLabel: string;
  startConnection: () => Promise<void>;
  reopenAuthorizationPage: (url: string) => void;
}

export function useFeishuConnections(enabled = true): FeishuConnectionsState {
  const { user } = useAuth();
  const [connections, setConnections] = useState<FeishuConnectionView[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [authSession, setAuthSession] = useState<FeishuAuthSessionView | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authServiceAvailable, setAuthServiceAvailable] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const authorizationPopupRef = useRef<Window | null>(null);
  const openedAuthorizationUrlRef = useRef<string | null>(null);
  const completedSessionRef = useRef<string | null>(null);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/feishu/connections");
      const data = await response.json().catch(() => ({})) as { connections?: FeishuConnectionView[]; error?: string };
      if (!response.ok) throw new Error(data.error || "飞书连接状态读取失败");
      setConnections(data.connections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "飞书连接状态读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAuthSession = useCallback(async () => {
    const response = await authFetch("/api/feishu/auth/session");
    const data = await response.json().catch(() => ({})) as { session?: FeishuAuthSessionView | null; error?: string };
    if (response.status === 503) setAuthServiceAvailable(false);
    if (!response.ok) throw new Error(data.error || "飞书授权状态读取失败");
    setAuthServiceAvailable(true);
    setAuthSession(data.session ?? null);
    return data.session ?? null;
  }, []);

  const reopenAuthorizationPage = useCallback((url: string) => {
    const existing = authorizationPopupRef.current;
    const popup = existing && !existing.closed ? existing : window.open("", "_blank");
    if (!popup) {
      setPopupBlocked(true);
      return;
    }
    popup.opener = null;
    popup.location.href = url;
    authorizationPopupRef.current = popup;
    openedAuthorizationUrlRef.current = url;
    setPopupBlocked(false);
  }, []);

  const startConnection = useCallback(async () => {
    if (authServiceAvailable === false) return;
    setConnecting(true);
    setAuthError(null);
    setPopupBlocked(false);
    openedAuthorizationUrlRef.current = null;
    const popup = window.open("", "_blank");
    if (popup) {
      popup.opener = null;
      writeFeishuAuthorizingPopup(popup);
      authorizationPopupRef.current = popup;
    } else {
      authorizationPopupRef.current = null;
      setPopupBlocked(true);
    }

    try {
      const response = await authFetch("/api/feishu/auth/session", { method: "POST" });
      const data = await response.json().catch(() => ({})) as { session?: FeishuAuthSessionView; error?: string };
      if (response.status === 503) setAuthServiceAvailable(false);
      if (!response.ok || !data.session) throw new Error(data.error || "飞书授权启动失败，请稍后重试");
      setAuthServiceAvailable(true);
      setAuthSession(data.session);
      if (data.session.authorizationUrl) reopenAuthorizationPage(data.session.authorizationUrl);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "飞书授权启动失败，请稍后重试");
      if (popup && !popup.closed) popup.close();
    } finally {
      setConnecting(false);
    }
  }, [authServiceAvailable, reopenAuthorizationPage]);

  useEffect(() => {
    if (!enabled) return;
    setAuthSession(null);
    setAuthError(null);
    void Promise.all([
      loadConnections(),
      loadAuthSession().catch((err) => setAuthError(err instanceof Error ? err.message : "飞书授权状态读取失败")),
    ]);
  }, [enabled, loadAuthSession, loadConnections, user?.id]);

  useEffect(() => {
    if (!enabled || (authSession?.status !== "starting" && authSession?.status !== "awaiting_user")) return;
    const timer = window.setInterval(() => {
      void loadAuthSession().catch((err) => setAuthError(err instanceof Error ? err.message : "飞书授权状态读取失败"));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [enabled, authSession?.status, loadAuthSession]);

  useEffect(() => {
    if (!enabled) return;
    const url = authSession?.authorizationUrl;
    if (authSession?.status === "awaiting_user" && url) {
      const popup = authorizationPopupRef.current;
      if (!popup || popup.closed) setPopupBlocked(true);
      else if (openedAuthorizationUrlRef.current !== url) reopenAuthorizationPage(url);
    }
    if (authSession?.status === "connected" && completedSessionRef.current !== authSession.sessionId) {
      completedSessionRef.current = authSession.sessionId;
      void loadConnections();
    }
  }, [enabled, authSession, loadConnections, reopenAuthorizationPage]);

  const authInProgress = authSession?.status === "starting" || authSession?.status === "awaiting_user";
  const needsReconnect = connections.some((connection) => connection.status === "disconnected");
  const hasConnected = connections.some((connection) => connection.status === "connected");
  const connectLabel = authServiceAvailable === false
    ? "服务尚未配置"
    : authInProgress || connecting
      ? "等待授权"
      : needsReconnect
        ? "重新连接"
        : hasConnected
          ? "重新授权"
          : "连接飞书";

  return {
    connections,
    loading,
    error,
    authSession,
    authError,
    authServiceUnavailable: authServiceAvailable === false,
    connecting,
    popupBlocked,
    authInProgress,
    needsReconnect,
    hasConnected,
    connectLabel,
    startConnection,
    reopenAuthorizationPage,
  };
}

export function feishuConnectorStatus(state: FeishuConnectionsState): { label: string; className: string } {
  if (state.loading) return { label: "检测中", className: "text-muted-foreground" };
  if (state.authInProgress || state.connecting) return { label: "等待授权", className: "text-blue-700 dark:text-blue-300" };
  if (state.authServiceUnavailable && !state.hasConnected) return { label: "待配置", className: "text-amber-700 dark:text-amber-300" };
  if (state.needsReconnect) return { label: "需重连", className: "text-destructive" };
  if (state.connections.some((item) => item.status === "error")) return { label: "重试中", className: "text-amber-700 dark:text-amber-300" };
  if (state.connections.some((item) => item.status === "pending")) return { label: "检测中", className: "text-blue-700 dark:text-blue-300" };
  if (state.hasConnected) return { label: "已连接", className: "text-success" };
  return { label: "未连接", className: "text-muted-foreground" };
}

export function feishuMatchesCatalog(query: string, activeFilter: string, state: FeishuConnectionsState): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  const matchesQuery = !normalized || "飞书 feishu lark 飞书连接 lark-cli".includes(normalized);
  const matchesFilter = activeFilter === "all"
    || activeFilter === "platform"
    || (activeFilter === "enabled" && state.hasConnected);
  return matchesQuery && matchesFilter;
}

export function FeishuBrandLogo({ className }: { className?: string }) {
  return (
    <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-inset ring-black/10", className)} aria-hidden="true">
      <span className="bg-gradient-to-br from-[#3370FF] via-[#00B8D9] to-[#7B61FF] bg-clip-text text-lg font-bold text-transparent">飞</span>
    </span>
  );
}

const DESCRIPTION = "连接飞书账号，让 Agent 使用文档、知识库、多维表格、日历、任务、群聊等能力。";

export function FeishuConnectorCard({ state, onOpenDetail }: { state: FeishuConnectionsState; onOpenDetail: () => void }) {
  const status = feishuConnectorStatus(state);
  const busy = state.authInProgress || state.connecting;
  return (
    <Card
      className="group cursor-pointer border-border/70 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md"
      onClick={onOpenDetail}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenDetail(); }
      }}
      role="button"
      tabIndex={0}
    >
      <CardContent className="flex min-h-36 items-start gap-4 p-5">
        <FeishuBrandLogo />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-semibold">飞书</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <CapabilitySourceBadge source="platform" />
                <span className={`text-xs font-medium ${status.className}`}>{status.label}</span>
              </div>
            </div>
            <button
              type="button"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
                state.hasConnected && !state.needsReconnect
                  ? "border-transparent bg-success text-success-foreground shadow-sm hover:bg-success/85"
                  : "bg-muted/40 text-muted-foreground hover:border-success/40 hover:bg-success/10 hover:text-success",
              )}
              disabled={busy || state.authServiceUnavailable}
              aria-label={state.hasConnected ? "查看 飞书" : "连接 飞书"}
              onClick={(event) => {
                event.stopPropagation();
                if (state.hasConnected && !state.needsReconnect) onOpenDetail();
                else void state.startConnection();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : state.hasConnected && !state.needsReconnect ? <Check className="size-4" strokeWidth={2.5} /> : <Plus className="size-4" />}
            </button>
          </div>
          <p className="mt-3 line-clamp-2 text-sm leading-5 text-muted-foreground">{DESCRIPTION}</p>
          <div className="mt-3 text-xs text-muted-foreground">点击查看授权账号与连接状态</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function FeishuConnectorDrawer({
  open,
  onOpenChange,
  state,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: FeishuConnectionsState;
}) {
  const status = feishuConnectorStatus(state);
  return (
    <CapabilityDetailDrawer open={open} onOpenChange={onOpenChange} title="飞书" description={DESCRIPTION}>
      <div className="flex items-center gap-3">
        <FeishuBrandLogo />
        <div><CapabilitySourceBadge source="platform" /><div className={`mt-1 text-xs font-medium ${status.className}`}>{status.label}</div></div>
      </div>
      <div className="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">
        连接一次后，平台会自动维护登录。授权只属于当前账号，组织内其他成员不能使用你的凭据。
      </div>

      {state.authError ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>{state.authError}</span>
        </div>
      ) : null}
      {state.authSession?.status === "starting" ? (
        <div className="flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-3 text-sm text-blue-800"><Loader2 className="size-4 animate-spin" />正在生成飞书官方授权页面</div>
      ) : state.authSession?.status === "awaiting_user" ? (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-900">
          <div className="font-medium">请在飞书官方页面查看权限并同意授权</div>
          <div className="mt-1 text-xs text-blue-800">完成后本页会自动更新，无需复制授权码。</div>
          {state.popupBlocked && state.authSession.authorizationUrl ? (
            <Button className="mt-3" size="sm" variant="outline" onClick={() => state.reopenAuthorizationPage(state.authSession!.authorizationUrl!)}>
              <ExternalLink className="size-3.5" />打开飞书授权页面
            </Button>
          ) : null}
        </div>
      ) : state.authSession?.status === "connected" ? (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm text-emerald-800"><CircleCheck className="size-4" />飞书连接成功，Agent 现在可以直接使用飞书能力</div>
      ) : state.authSession?.status === "failed" || state.authSession?.status === "expired" ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900"><TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>{state.authSession.message}</span></div>
      ) : null}

      {state.loading ? (
        <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取连接状态</div>
      ) : state.error ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900"><TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>{state.error}，不影响已经保存的飞书授权。</span></div>
      ) : state.connections.length === 0 ? (
        <div className="rounded-xl bg-muted/50 px-3 py-3 text-sm"><div className="font-medium">尚未连接飞书</div><div className="mt-1 text-muted-foreground">点击“连接飞书”，在飞书官方页面确认一次即可。</div></div>
      ) : (
        <div className="space-y-2">
          {state.connections.map((item) => {
            const connected = item.status === "connected";
            const pending = item.status === "pending";
            return (
              <div key={item.profileId} className="flex items-start justify-between gap-4 rounded-xl border px-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{item.userName || "飞书账号"}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{item.message}</div>
                  {item.lastCheckedAt ? <div className="mt-1 text-[11px] text-muted-foreground">最近检查：{formatTime(item.lastCheckedAt)}</div> : null}
                </div>
                <div className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
                  connected && "bg-emerald-50 text-emerald-700",
                  pending && "bg-blue-50 text-blue-700",
                  item.status === "error" && "bg-amber-50 text-amber-800",
                  item.status === "disconnected" && "bg-red-50 text-red-700",
                )}>
                  {connected ? <CircleCheck className="size-3.5" /> : pending ? <Loader2 className="size-3.5 animate-spin" /> : <TriangleAlert className="size-3.5" />}
                  {connected ? "已连接" : pending ? "检测中" : item.status === "error" ? "重试中" : "需重连"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Button
        className="w-full"
        variant={state.hasConnected && !state.needsReconnect ? "outline" : "default"}
        disabled={state.authServiceUnavailable || state.authInProgress || state.connecting}
        onClick={() => { void state.startConnection(); }}
      >
        {(state.authInProgress || state.connecting) ? <Loader2 className="size-4 animate-spin" /> : null}
        {state.connectLabel}
      </Button>
    </CapabilityDetailDrawer>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}
