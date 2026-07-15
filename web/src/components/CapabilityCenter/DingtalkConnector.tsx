/**
 * 钉钉连接（DWS device flow）在能力中心「连接器」目录里的一等卡片。
 *
 * 钉钉不是 MCP server：它是「一个用户 × N 个组织 profile」的平台内置连接，
 * token 落用户 workspace 的 .dws/，服务端逐 profile 守活，没有启用/停用概念——
 * 连接即生效。因此不进入 McpManager 的 servers 数据流，而是以独立
 * hook + 卡片 + 详情抽屉的形式与 MCP 连接器同 grid 融合渲染。
 *
 * 逻辑自 SettingsCenter/SettingsModal.tsx 的 DwsConnectionsSection 平移
 * （原「设置 → 账户 → 钉钉连接」入口已下线）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleCheck, ExternalLink, Loader2, Plus, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";
import { cn } from "@/lib/utils";
import { CapabilityDetailDrawer, CapabilitySourceBadge, CatalogHeader } from "./CatalogUi";
import dingtalkIcon from "@/assets/connector-brands/dingtalk.svg";

export interface DwsConnectionView {
  profileId: string;
  profileName: string | null;
  corpName: string | null;
  dingtalkUserName: string | null;
  status: "pending" | "connected" | "error" | "disconnected";
  authenticated: boolean | null;
  refreshTokenValid: boolean | null;
  refreshExpiresAt: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  message: string;
}

export interface DwsAuthSessionView {
  sessionId: string;
  status: "starting" | "awaiting_user" | "connected" | "failed" | "expired";
  authorizationUrl: string | null;
  userCode: string | null;
  expiresAt: string;
  message: string;
}

export interface DwsConnectionsState {
  connections: DwsConnectionView[];
  loading: boolean;
  error: string | null;
  authSession: DwsAuthSessionView | null;
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

/**
 * DWS 连接状态 + device flow 授权的完整状态机。
 * @param enabled 传 false 时不发任何请求（McpManager admin 模式复用组件时避免多余请求）。
 */
export function useDwsConnections(enabled = true): DwsConnectionsState {
  const { user } = useAuth();
  const [connections, setConnections] = useState<DwsConnectionView[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [authSession, setAuthSession] = useState<DwsAuthSessionView | null>(null);
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
      const response = await authFetch("/api/dws/connections");
      const data = await response.json().catch(() => ({})) as { connections?: DwsConnectionView[]; error?: string };
      if (!response.ok) throw new Error(data.error || "钉钉连接状态读取失败");
      setConnections(data.connections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "钉钉连接状态读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAuthSession = useCallback(async () => {
    const response = await authFetch("/api/dws/auth/session");
    const data = await response.json().catch(() => ({})) as { session?: DwsAuthSessionView | null; error?: string };
    if (response.status === 503) setAuthServiceAvailable(false);
    if (!response.ok) throw new Error(data.error || "钉钉授权状态读取失败");
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
      popup.document.title = "正在连接钉钉";
      popup.document.body.textContent = "正在打开钉钉官方授权页面…";
      authorizationPopupRef.current = popup;
    } else {
      authorizationPopupRef.current = null;
      setPopupBlocked(true);
    }

    try {
      const response = await authFetch("/api/dws/auth/session", { method: "POST" });
      const data = await response.json().catch(() => ({})) as { session?: DwsAuthSessionView; error?: string };
      if (response.status === 503) setAuthServiceAvailable(false);
      if (!response.ok || !data.session) throw new Error(data.error || "钉钉授权启动失败，请稍后重试");
      setAuthServiceAvailable(true);
      setAuthSession(data.session);
      if (data.session.authorizationUrl) reopenAuthorizationPage(data.session.authorizationUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : "钉钉授权启动失败，请稍后重试";
      setAuthError(message);
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
      loadAuthSession().catch((err) => setAuthError(err instanceof Error ? err.message : "钉钉授权状态读取失败")),
    ]);
  }, [enabled, loadAuthSession, loadConnections, user?.id]);

  useEffect(() => {
    if (!enabled) return;
    if (authSession?.status !== "starting" && authSession?.status !== "awaiting_user") return;
    const timer = window.setInterval(() => {
      void loadAuthSession().catch((err) => setAuthError(err instanceof Error ? err.message : "钉钉授权状态读取失败"));
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
  const authServiceUnavailable = authServiceAvailable === false;
  const needsReconnect = connections.some((connection) => connection.status === "disconnected");
  const hasConnected = connections.some((connection) => connection.status === "connected");
  const connectLabel = authServiceUnavailable
    ? "服务暂不可用"
    : authInProgress || connecting
      ? "等待授权"
      : needsReconnect
        ? "重新连接"
        : connections.length > 0
          ? "连接其他组织"
          : "连接钉钉";

  return {
    connections,
    loading,
    error,
    authSession,
    authError,
    authServiceUnavailable,
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

export function dingtalkConnectorStatus(dws: DwsConnectionsState): { label: string; className: string } {
  if (dws.loading) return { label: "检测中", className: "text-muted-foreground" };
  if (dws.authInProgress || dws.connecting) return { label: "等待授权", className: "text-blue-700 dark:text-blue-300" };
  if (dws.needsReconnect) return { label: "需重连", className: "text-destructive" };
  if (dws.connections.some((connection) => connection.status === "error")) {
    return { label: "重试中", className: "text-amber-700 dark:text-amber-300" };
  }
  if (dws.connections.some((connection) => connection.status === "pending")) {
    return { label: "检测中", className: "text-blue-700 dark:text-blue-300" };
  }
  if (dws.hasConnected) {
    const count = dws.connections.filter((connection) => connection.status === "connected").length;
    return { label: count > 1 ? `已连接 ${count} 个组织` : "已连接", className: "text-success" };
  }
  return { label: "未连接", className: "text-muted-foreground" };
}

/** 搜索/筛选联动：钉钉卡片是否应出现在当前目录视图。 */
export function dingtalkMatchesCatalog(query: string, activeFilter: string, dws: DwsConnectionsState): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  const matchesQuery = !normalized || "钉钉 dingtalk 钉钉连接 dws".includes(normalized);
  const matchesFilter = activeFilter === "all"
    || activeFilter === "platform"
    || (activeFilter === "enabled" && dws.hasConnected);
  return matchesQuery && matchesFilter;
}

export function DingtalkBrandLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-inset ring-black/10 dark:bg-white",
        className,
      )}
      aria-hidden="true"
    >
      <img src={dingtalkIcon} alt="" className="size-7 object-contain" />
    </span>
  );
}

const DINGTALK_DESCRIPTION = "连接钉钉组织，让 Agent 使用日程、文档、审批、通讯录等钉钉能力。";

export function DingtalkConnectorCard({
  dws,
  onOpenDetail,
}: {
  dws: DwsConnectionsState;
  onOpenDetail: () => void;
}) {
  const status = dingtalkConnectorStatus(dws);
  const busy = dws.authInProgress || dws.connecting;
  const actionLabel = dws.hasConnected && !dws.needsReconnect ? "查看 钉钉" : "连接 钉钉";
  return (
    <Card
      className="group cursor-pointer border-border/70 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md"
      onClick={onOpenDetail}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <CardContent className="flex min-h-36 items-start gap-4 p-5">
        <DingtalkBrandLogo />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-semibold">钉钉</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <CapabilitySourceBadge source="platform" />
                <span className={`text-xs font-medium ${status.className}`}>{status.label}</span>
              </div>
            </div>
            <button
              type="button"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
                dws.hasConnected && !dws.needsReconnect
                  ? "border-transparent bg-success text-success-foreground shadow-sm hover:bg-success/85"
                  : "bg-muted/40 text-muted-foreground hover:border-success/40 hover:bg-success/10 hover:text-success",
              )}
              disabled={busy || dws.authServiceUnavailable}
              aria-label={actionLabel}
              onClick={(event) => {
                event.stopPropagation();
                if (dws.hasConnected && !dws.needsReconnect) {
                  onOpenDetail();
                } else {
                  void dws.startConnection();
                }
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : dws.hasConnected && !dws.needsReconnect ? <Check className="size-4" strokeWidth={2.5} /> : <Plus className="size-4" />}
            </button>
          </div>
          <p className="mt-3 line-clamp-2 text-sm leading-5 text-muted-foreground">{DINGTALK_DESCRIPTION}</p>
          <div className="mt-3 text-xs text-muted-foreground">点击查看连接状态与组织</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DingtalkConnectorDrawer({
  open,
  onOpenChange,
  dws,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dws: DwsConnectionsState;
}) {
  const status = dingtalkConnectorStatus(dws);
  return (
    <CapabilityDetailDrawer open={open} onOpenChange={onOpenChange} title="钉钉" description={DINGTALK_DESCRIPTION}>
      <div className="flex items-center gap-3">
        <DingtalkBrandLogo />
        <div>
          <CapabilitySourceBadge source="platform" />
          <div className={`mt-1 text-xs font-medium ${status.className}`}>{status.label}</div>
        </div>
      </div>

      <div className="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">
        连接一次后，平台会自动维持登录，无需定期重新授权。授权只属于当前账号，组织内其他成员无法使用你的凭据。
      </div>

      {dws.authError ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{dws.authError}</span>
        </div>
      ) : null}

      {dws.authSession?.status === "starting" ? (
        <div className="flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-3 text-sm text-blue-800">
          <Loader2 className="size-4 animate-spin" />正在生成钉钉官方授权页面
        </div>
      ) : dws.authSession?.status === "awaiting_user" ? (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-900">
          <div className="font-medium">请在钉钉页面选择组织并同意授权</div>
          <div className="mt-1 text-xs text-blue-800">授权码：{dws.authSession.userCode || "正在读取"}</div>
          {dws.popupBlocked && dws.authSession.authorizationUrl ? (
            <Button className="mt-3" size="sm" variant="outline" onClick={() => dws.reopenAuthorizationPage(dws.authSession!.authorizationUrl!)}>
              <ExternalLink className="size-3.5" />打开钉钉授权页面
            </Button>
          ) : null}
        </div>
      ) : dws.authSession?.status === "connected" ? (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
          <CircleCheck className="size-4" />钉钉连接成功，Agent 现在可以直接使用钉钉能力
        </div>
      ) : dws.authSession?.status === "failed" || dws.authSession?.status === "expired" ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{dws.authSession.message}</span>
        </div>
      ) : null}

      {dws.loading ? (
        <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />正在读取连接状态
        </div>
      ) : dws.error ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{dws.error}，不影响已经保存的钉钉授权。</span>
        </div>
      ) : dws.connections.length === 0 ? (
        <div className="rounded-xl bg-muted/50 px-3 py-3 text-sm">
          <div className="font-medium">尚未连接钉钉</div>
          <div className="mt-1 text-muted-foreground">点击“连接钉钉”，在钉钉官方页面确认一次即可。</div>
        </div>
      ) : (
        <div className="space-y-2">
          {dws.connections.map((connection) => {
            const connected = connection.status === "connected";
            const pending = connection.status === "pending";
            return (
              <div key={connection.profileId} className="flex items-start justify-between gap-4 rounded-xl border px-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{connection.corpName || connection.profileName || "钉钉组织"}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {connection.dingtalkUserName ? `${connection.dingtalkUserName} · ` : ""}{connection.message}
                  </div>
                  {connection.lastCheckedAt ? (
                    <div className="mt-1 text-[11px] text-muted-foreground">最近检查：{formatDwsConnectionTime(connection.lastCheckedAt)}</div>
                  ) : null}
                </div>
                <div className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
                  connected && "bg-emerald-50 text-emerald-700",
                  pending && "bg-blue-50 text-blue-700",
                  connection.status === "error" && "bg-amber-50 text-amber-800",
                  connection.status === "disconnected" && "bg-red-50 text-red-700",
                )}>
                  {connected ? <CircleCheck className="size-3.5" /> : pending ? <Loader2 className="size-3.5 animate-spin" /> : <TriangleAlert className="size-3.5" />}
                  {connected ? "已连接" : pending ? "检测中" : connection.status === "error" ? "重试中" : "需重连"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Button
        className="w-full"
        variant={dws.hasConnected && !dws.needsReconnect ? "outline" : "default"}
        disabled={dws.authServiceUnavailable || dws.authInProgress || dws.connecting}
        onClick={() => { void dws.startConnection(); }}
      >
        {(dws.authInProgress || dws.connecting) ? <Loader2 className="size-4 animate-spin" /> : null}
        {dws.connectLabel}
      </Button>
    </CapabilityDetailDrawer>
  );
}

/** personalAgentEnabled=false 的租户没有 MCP 连接器目录，但钉钉连接必须保留入口。 */
export function DingtalkOnlyConnectors() {
  const dws = useDwsConnections();
  const [detailOpen, setDetailOpen] = useState(false);
  const openDetail = useCallback(() => setDetailOpen(true), []);
  return (
    <div className="flex min-h-0 w-full flex-col">
      <CatalogHeader
        title="连接器"
        description="连接常用账号，让 Agent 在你的权限范围内使用数据和工具。"
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        <DingtalkConnectorCard dws={dws} onOpenDetail={openDetail} />
      </div>
      <DingtalkConnectorDrawer open={detailOpen} onOpenChange={setDetailOpen} dws={dws} />
    </div>
  );
}

function formatDwsConnectionTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
