/**
 * 钉钉连接（DWS device flow）在能力中心「连接器」目录里的一等卡片。
 *
 * 钉钉不是 MCP server：它是「一个用户 × N 个组织 profile」的平台内置连接，
 * token 落用户 workspace 的 .dws/，服务端逐 profile 守活；暂停仅切断运行时使用，
 * 不删除授权。因此不进入 McpManager 的 servers 数据流，而是以独立
 * hook + 卡片 + 详情抽屉的形式与 MCP 连接器同 grid 融合渲染。
 *
 * 逻辑自 SettingsCenter/SettingsModal.tsx 的 DwsConnectionsSection 平移
 * （原「设置 → 账户 → 钉钉连接」入口已下线）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, ExternalLink, Loader2, TriangleAlert, Unplug } from "lucide-react";
import { setNativeConnectorRuntimeEnabled } from "@agent/shared";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";
import { cn } from "@/lib/utils";
import {
  CapabilityDetailDrawer,
  CapabilitySourceBadge,
  CatalogHeader,
  ConnectorCatalogCard,
  CAPABILITY_SUBTLE_SURFACE,
} from "./CatalogUi";
import { writeDingtalkAuthorizingPopup } from "./dingtalkAuthorizingPopup";
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
  runtimeEnabled: boolean;
  runtimeSaving: boolean;
  connectLabel: string;
  disconnectingProfileId: string | null;
  startConnection: () => Promise<void>;
  setRuntimeEnabled: (enabled: boolean) => Promise<void>;
  cancelAuthorization: () => Promise<void>;
  disconnectConnection: (profileId: string) => Promise<void>;
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
  const [runtimeEnabled, setRuntimeEnabledState] = useState(true);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [disconnectingProfileId, setDisconnectingProfileId] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const authorizationPopupRef = useRef<Window | null>(null);
  const openedAuthorizationUrlRef = useRef<string | null>(null);
  const completedSessionRef = useRef<string | null>(null);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/dws/connections");
      const data = await response.json().catch(() => ({})) as { connections?: DwsConnectionView[]; runtimeEnabled?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "钉钉连接状态读取失败");
      setConnections(data.connections ?? []);
      setRuntimeEnabledState(data.runtimeEnabled ?? true);
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

    // 弹窗必须在用户手势的同步栈里 open，才能穿过 popup blocker。
    // 此时 device flow 尚未返回 authorizationUrl，先写一个品牌化的等待页
    // 覆盖 about:blank——sandbox 冷启动到申请到授权码可能耗时 1-3 分钟。
    const popup = window.open("", "_blank");
    if (popup) {
      popup.opener = null;
      writeDingtalkAuthorizingPopup(popup);
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

  const setRuntimeEnabled = useCallback(async (nextEnabled: boolean) => {
    setRuntimeSaving(true);
    setAuthError(null);
    try {
      await setNativeConnectorRuntimeEnabled("dws", nextEnabled);
      setRuntimeEnabledState(nextEnabled);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "钉钉状态更新失败");
    } finally {
      setRuntimeSaving(false);
    }
  }, []);

  const cancelAuthorization = useCallback(async () => {
    setConnecting(true);
    setAuthError(null);
    try {
      const response = await authFetch("/api/dws/auth/session", { method: "DELETE" });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || "钉钉授权取消失败，请稍后重试");
      setAuthSession(null);
      const popup = authorizationPopupRef.current;
      if (popup && !popup.closed) popup.close();
      authorizationPopupRef.current = null;
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "钉钉授权取消失败，请稍后重试");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnectConnection = useCallback(async (profileId: string) => {
    setDisconnectingProfileId(profileId);
    setAuthError(null);
    try {
      const response = await authFetch(`/api/dws/connections?profileId=${encodeURIComponent(profileId)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({})) as { connections?: DwsConnectionView[]; error?: string };
      if (!response.ok) throw new Error(data.error || "钉钉断开失败，请稍后重试");
      setConnections(data.connections ?? []);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "钉钉断开失败，请稍后重试");
    } finally {
      setDisconnectingProfileId(null);
    }
  }, []);

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

  // 授权成功后，后端会紧接着完成首次凭据检测。避免只读取一次 pending 状态后
  // 永久停在「检测中」，直到检测落定前持续刷新连接状态。
  useEffect(() => {
    if (!enabled || !connections.some((connection) => connection.status === "pending")) return;
    const timer = window.setInterval(() => {
      void loadConnections();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [connections, enabled, loadConnections]);

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
    runtimeEnabled,
    runtimeSaving,
    connectLabel,
    disconnectingProfileId,
    startConnection,
    setRuntimeEnabled,
    cancelAuthorization,
    disconnectConnection,
    reopenAuthorizationPage,
  };
}

export function dingtalkConnectorStatus(dws: DwsConnectionsState): { label: string; className: string } {
  if (dws.loading) return { label: "检测中", className: "text-muted-foreground" };
  if (dws.authInProgress || dws.connecting) return { label: "等待授权", className: "text-info-ink" };
  if (dws.needsReconnect) return { label: "需重连", className: "text-destructive" };
  if (dws.connections.some((connection) => connection.status === "error")) {
    return { label: "重试中", className: "text-warning-ink" };
  }
  if (dws.connections.some((connection) => connection.status === "pending")) {
    return { label: "检测中", className: "text-info-ink" };
  }
  if (dws.hasConnected && !dws.runtimeEnabled) {
    return { label: "已暂停", className: "text-muted-foreground" };
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
    || (activeFilter === "enabled" && dws.hasConnected && dws.runtimeEnabled);
  return matchesQuery && matchesFilter;
}

export function DingtalkBrandLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white ring-1 ring-inset ring-black/10 dark:bg-white",
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
  const busy = dws.authInProgress || dws.connecting || dws.runtimeSaving;
  const connected = dws.hasConnected && !dws.needsReconnect;
  const actionLabel = connected ? dws.runtimeEnabled ? "暂停" : "恢复" : "连接";
  return (
    <ConnectorCatalogCard
      name="钉钉"
      logo={<DingtalkBrandLogo />}
      source="platform"
      statusLabel={status.label}
      statusClassName={status.className}
      description={DINGTALK_DESCRIPTION}
      metadata="官方 CLI：dws · 支持多组织 profile"
      onOpenDetail={onOpenDetail}
      actionLabel={actionLabel}
      actionIcon={busy ? <Loader2 className="size-4 animate-spin" /> : undefined}
      actionTone={connected && dws.runtimeEnabled ? "success" : "default"}
      actionDisabled={busy || dws.authServiceUnavailable}
      onAction={() => {
        if (connected) void dws.setRuntimeEnabled(!dws.runtimeEnabled);
        else void dws.startConnection();
      }}
    />
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

      <div className={cn("p-3 text-sm text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>
        连接一次后，官方 dws CLI 会使用当前用户独立的 DWS_CONFIG_DIR 与多组织 profile；组织内其他成员无法使用你的凭据。
      </div>

      {dws.authError ? (
        <div className="flex items-start gap-2 rounded-xl bg-warning-subtle px-3 py-3 text-sm text-warning-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{dws.authError}</span>
        </div>
      ) : null}

      {dws.authSession?.status === "starting" ? (
        <div className="flex items-center gap-2 rounded-xl bg-info-subtle px-3 py-3 text-sm text-info-ink">
          <Loader2 className="size-4 animate-spin" />正在生成钉钉官方授权页面
        </div>
      ) : dws.authSession?.status === "awaiting_user" ? (
        <div className="rounded-xl bg-info-subtle px-3 py-3 text-sm text-info-ink ring-1 ring-info/25">
          <div className="font-medium">请在钉钉页面选择组织并同意授权</div>
          <div className="mt-1 text-xs text-info-ink/85">授权码：{dws.authSession.userCode || "正在读取"}</div>
          {dws.popupBlocked && dws.authSession.authorizationUrl ? (
            <Button className="mt-3" size="sm" variant="outline" onClick={() => dws.reopenAuthorizationPage(dws.authSession!.authorizationUrl!)}>
              <ExternalLink className="size-3.5" />打开钉钉授权页面
            </Button>
          ) : null}
        </div>
      ) : dws.authSession?.status === "connected" ? (
        <div className="flex items-center gap-2 rounded-xl bg-success-subtle px-3 py-3 text-sm text-success-ink">
          <CircleCheck className="size-4" />钉钉连接成功，Agent 现在可以直接使用钉钉能力
        </div>
      ) : dws.authSession?.status === "failed" || dws.authSession?.status === "expired" ? (
        <div className="flex items-start gap-2 rounded-xl bg-warning-subtle px-3 py-3 text-sm text-warning-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{dws.authSession.message}</span>
        </div>
      ) : null}

      {dws.loading ? (
        <div className={cn("flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>
          <Loader2 className="size-4 animate-spin" />正在读取连接状态
        </div>
      ) : dws.error ? (
        <div className="flex items-start gap-2 rounded-xl bg-warning-subtle px-3 py-3 text-sm text-warning-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{dws.error}，不影响已经保存的钉钉授权。</span>
        </div>
      ) : dws.connections.length === 0 ? (
        <div className={cn("px-3 py-3 text-sm", CAPABILITY_SUBTLE_SURFACE)}>
          <div className="font-medium">尚未连接钉钉</div>
          <div className="mt-1 text-muted-foreground">点击“连接钉钉”，在钉钉官方页面确认一次即可。</div>
        </div>
      ) : (
        <div className="space-y-2">
          {dws.connections.map((connection) => {
            const connected = connection.status === "connected";
            const pending = connection.status === "pending";
            return (
              <div key={connection.profileId} className="flex items-start justify-between gap-4 rounded-xl px-3 py-3 ring-1 ring-border/60">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{connection.corpName || connection.profileName || "钉钉组织"}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {connection.dingtalkUserName ? `${connection.dingtalkUserName} · ` : ""}{connection.message}
                  </div>
                  {connection.lastCheckedAt ? (
                    <div className="mt-1 text-[11px] text-muted-foreground">最近检查：{formatDwsConnectionTime(connection.lastCheckedAt)}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className={cn(
                    "flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
                    connected && "bg-success-subtle text-success-ink",
                    pending && "bg-info-subtle text-info-ink",
                    connection.status === "error" && "bg-warning-subtle text-warning-ink",
                    connection.status === "disconnected" && "bg-danger-subtle text-danger-ink",
                  )}>
                    {connected ? <CircleCheck className="size-3.5" /> : pending ? <Loader2 className="size-3.5 animate-spin" /> : <TriangleAlert className="size-3.5" />}
                    {connected ? "已连接" : pending ? "检测中" : connection.status === "error" ? "重试中" : "需重连"}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    disabled={dws.disconnectingProfileId === connection.profileId}
                    aria-label={`断开 ${connection.corpName || connection.profileName || "钉钉组织"}`}
                    onClick={() => {
                      if (window.confirm("确认断开这个钉钉组织？断开后 Agent 将无法继续访问该组织。")) {
                        void dws.disconnectConnection(connection.profileId);
                      }
                    }}
                  >
                    {dws.disconnectingProfileId === connection.profileId ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Button
        className="w-full"
        variant={dws.authInProgress || (dws.hasConnected && !dws.needsReconnect) ? "outline" : "default"}
        disabled={dws.authServiceUnavailable || dws.connecting}
        onClick={() => { void (dws.authInProgress ? dws.cancelAuthorization() : dws.startConnection()); }}
      >
        {dws.connecting ? <Loader2 className="size-4 animate-spin" /> : dws.authInProgress ? <Unplug className="size-4" /> : null}
        {dws.authInProgress ? "取消授权" : dws.connectLabel}
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
