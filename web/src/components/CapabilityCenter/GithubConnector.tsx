import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, ExternalLink, Github, Loader2 } from "lucide-react";
import {
  connectGithub,
  disconnectGithub,
  fetchGithubConnection,
  setNativeConnectorRuntimeEnabled,
  type GithubConnection,
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

const DISCONNECTED: GithubConnection = {
  connectorId: "github",
  status: "disconnected",
  runtimeEnabled: true,
};

const DESCRIPTION = "授权后，原生 Git、gh、SDK 和 Shell 在当前用户运行环境中直接可用。";

function GithubLogo() {
  return (
    <CapabilityLogo label="GitHub" className="bg-foreground text-background ring-foreground/10 dark:bg-foreground dark:text-background">
      <Github className="size-6" />
    </CapabilityLogo>
  );
}

export function GithubConnector({
  onConnectionChange,
}: {
  onConnectionChange?: (connected: boolean) => void;
}) {
  const [connection, setConnection] = useState<GithubConnection>(DISCONNECTED);
  const [detailOpen, setDetailOpen] = useState(false);
  const [token, setToken] = useState("");
  const [editingCredential, setEditingCredential] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setError(undefined);
      const result = await fetchGithubConnection();
      setConnection(result.connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取 GitHub 连接失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!loading) onConnectionChange?.(connection.status === "connected" && connection.runtimeEnabled !== false);
  }, [connection.runtimeEnabled, connection.status, loading, onConnectionChange]);

  const saveCredential = async () => {
    if (!token.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await connectGithub({ token });
      setConnection(result.connection);
      setEditingCredential(false);
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接 GitHub 失败");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("确定断开 GitHub？运行态 Git、gh 和 SDK 都将停止使用该凭据。")) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await disconnectGithub();
      setConnection(result.connection);
      setEditingCredential(false);
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "断开 GitHub 失败");
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
      const result = await setNativeConnectorRuntimeEnabled("github", !connection.runtimeEnabled);
      setConnection((current) => ({ ...current, runtimeEnabled: result.runtimeEnabled }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub 状态更新失败");
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
        name="GitHub"
        logo={<GithubLogo />}
        source="platform"
        statusLabel={statusLabel}
        statusClassName={connected && runtimeEnabled ? "text-success" : "text-muted-foreground"}
        description={DESCRIPTION}
        metadata="原生 Git · 官方 CLI：gh"
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
            setToken("");
          }
        }}
        title="GitHub"
        description={DESCRIPTION}
      >
        <div className="flex items-center gap-3">
          <GithubLogo />
          <div>
            <CapabilitySourceBadge source="platform" />
            <div className={cn("mt-1 flex items-center gap-1 text-xs font-medium", connected && runtimeEnabled ? "text-success" : "text-muted-foreground")}>
              {connected && runtimeEnabled ? <CircleCheck className="size-3.5" /> : null}
              {statusLabel}
            </div>
          </div>
        </div>

        <div className={cn("p-3 text-sm leading-6 text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>
          使用 Personal Access Token 连接。凭据仅保存到当前用户的加密存储，并注入其独立运行环境。
        </div>

        {!loading && (!connected || editingCredential) ? (
          <div className="space-y-2 rounded-xl p-4 ring-1 ring-border/60">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="github-token">Personal Access Token</Label>
              <a
                href="https://github.com/settings/tokens/new"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                创建 Token <ExternalLink className="size-3" />
              </a>
            </div>
            <Input
              id="github-token"
              name="github-personal-access-token"
              type="password"
              autoComplete="new-password"
              passwordManager="ignore"
              className="border-transparent bg-muted/50 shadow-none focus-visible:bg-card"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="github_pat_… 或 ghp_…"
            />
            <p className="text-xs leading-5 text-muted-foreground">建议授予 repo、read:org 权限；更新凭据后旧 Token 会被替换。</p>
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
              <Button variant="ghost" onClick={() => { setEditingCredential(false); setToken(""); }} disabled={saving}>
                取消
              </Button>
            ) : null}
            {!connected || editingCredential ? (
              <Button onClick={() => void saveCredential()} disabled={saving || !token.trim()}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {connected ? "保存新凭据" : "连接 GitHub"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CapabilityDetailDrawer>
    </>
  );
}
