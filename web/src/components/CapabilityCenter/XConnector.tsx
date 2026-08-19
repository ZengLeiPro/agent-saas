import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import {
  connectX,
  disconnectX,
  fetchXConnection,
  setNativeConnectorRuntimeEnabled,
  type XConnection,
} from "@agent/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  CAPABILITY_SUBTLE_SURFACE,
  CapabilityDetailDrawer,
  CapabilityLogo,
  CapabilitySourceBadge,
  ConnectorCatalogCard,
} from "./CatalogUi";

const DISCONNECTED: XConnection = {
  connectorId: "x",
  status: "disconnected",
  runtimeEnabled: true,
};

const DESCRIPTION = "使用 bird CLI 在当前用户的独立运行环境中读取、搜索和发布 X 内容。";

function XLogo() {
  return (
    <CapabilityLogo label="X" className="bg-black text-white ring-black/10 dark:bg-white dark:text-black">
      <span className="text-xl font-semibold leading-none">𝕏</span>
    </CapabilityLogo>
  );
}

export function XConnector({
  onConnectionChange,
}: {
  onConnectionChange?: (connected: boolean) => void;
}) {
  const [connection, setConnection] = useState<XConnection>(DISCONNECTED);
  const [detailOpen, setDetailOpen] = useState(false);
  const [authToken, setAuthToken] = useState("");
  const [ct0, setCt0] = useState("");
  const [editingCredential, setEditingCredential] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setError(undefined);
      const result = await fetchXConnection();
      setConnection(result.connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取 X 连接失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!loading) onConnectionChange?.(connection.status === "connected" && connection.runtimeEnabled !== false);
  }, [connection.runtimeEnabled, connection.status, loading, onConnectionChange]);

  const saveCredential = async () => {
    if (!authToken.trim() || !ct0.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await connectX({ authToken, ct0 });
      setConnection(result.connection);
      setEditingCredential(false);
      setAuthToken("");
      setCt0("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接 X 失败");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("确定断开 X？运行态 bird 将停止使用该账号凭据。")) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await disconnectX();
      setConnection(result.connection);
      setEditingCredential(false);
      setAuthToken("");
      setCt0("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "断开 X 失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleRuntime = async () => {
    if (connection.status !== "connected") {
      setDetailOpen(true);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const result = await setNativeConnectorRuntimeEnabled("x", !connection.runtimeEnabled);
      setConnection((current) => ({ ...current, runtimeEnabled: result.runtimeEnabled }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "X 状态更新失败");
      setDetailOpen(true);
    } finally {
      setSaving(false);
    }
  };

  const connected = connection.status === "connected";
  const runtimeEnabled = connection.runtimeEnabled !== false;
  const statusLabel = loading ? "检测中" : connected ? runtimeEnabled ? "已连接" : "已暂停" : "未连接";

  return (
    <>
      <ConnectorCatalogCard
        name="X"
        logo={<XLogo />}
        source="platform"
        statusLabel={statusLabel}
        statusClassName={connected && runtimeEnabled ? "text-success" : "text-muted-foreground"}
        description={DESCRIPTION}
        metadata="CLI：bird · X cookie auth"
        onOpenDetail={() => setDetailOpen(true)}
        actionLabel={connected ? runtimeEnabled ? "暂停" : "恢复" : "连接"}
        actionIcon={loading || saving ? <Loader2 className="size-4 animate-spin" /> : undefined}
        actionTone={connected && runtimeEnabled ? "success" : "default"}
        actionDisabled={loading || saving}
        onAction={() => { void toggleRuntime(); }}
      />

      <CapabilityDetailDrawer
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setEditingCredential(false);
            setAuthToken("");
            setCt0("");
          }
        }}
        title="X"
        description={DESCRIPTION}
      >
        <div className="flex items-center gap-3">
          <XLogo />
          <div>
            <CapabilitySourceBadge source="platform" />
            <div className={cn("mt-1 flex items-center gap-1 text-xs font-medium", connected && runtimeEnabled ? "text-success" : "text-muted-foreground")}>
              {connected && runtimeEnabled ? <CircleCheck className="size-3.5" /> : null}
              {statusLabel}
            </div>
          </div>
        </div>

        <div className={cn("p-3 text-sm leading-6 text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>
          bird 使用 X 未公开的 GraphQL 接口和 cookie auth。请仅粘贴当前账号的 <code>auth_token</code> 与 <code>ct0</code>，平台不会读取浏览器 Cookie。该 npm 包已停止维护，X 接口变化可能导致连接失效。
        </div>

        {!loading && (!connected || editingCredential) ? (
          <div className="space-y-3 rounded-xl p-4 ring-1 ring-border/60">
            <div className="space-y-2">
              <Label htmlFor="x-auth-token">auth_token</Label>
              <Input
                id="x-auth-token"
                name="x-auth-token"
                type="password"
                autoComplete="new-password"
                passwordManager="ignore"
                className="border-transparent bg-muted/50 shadow-none focus-visible:bg-card"
                value={authToken}
                onChange={(event) => setAuthToken(event.target.value)}
                placeholder="X Cookie：auth_token"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="x-ct0">ct0</Label>
              <Input
                id="x-ct0"
                name="x-ct0"
                type="password"
                autoComplete="new-password"
                passwordManager="ignore"
                className="border-transparent bg-muted/50 shadow-none focus-visible:bg-card"
                value={ct0}
                onChange={(event) => setCt0(event.target.value)}
                placeholder="X Cookie：ct0"
              />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">这两个值等同于 X 登录会话凭据，请勿在聊天、日志或截图中暴露。</p>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {!loading ? (
          <div className="flex flex-wrap justify-end gap-2">
            {connected && !editingCredential ? (
              <Button variant="outline" onClick={() => setEditingCredential(true)} disabled={saving}>
                更新凭据
              </Button>
            ) : null}
            {connected && !editingCredential ? (
              <Button variant="destructive" onClick={() => void disconnect()} disabled={saving}>
                断开连接
              </Button>
            ) : null}
            {editingCredential ? (
              <Button variant="ghost" onClick={() => { setEditingCredential(false); setAuthToken(""); setCt0(""); }} disabled={saving}>
                取消
              </Button>
            ) : null}
            {!connected || editingCredential ? (
              <Button onClick={() => void saveCredential()} disabled={saving || !authToken.trim() || !ct0.trim()}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {connected ? "保存新凭据" : "连接 X"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CapabilityDetailDrawer>
    </>
  );
}
