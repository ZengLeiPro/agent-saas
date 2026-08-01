import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, ExternalLink, Github, Loader2 } from "lucide-react";
import {
  connectGithub,
  disconnectGithub,
  fetchGithubConnection,
  type GithubConnection,
} from "@agent/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { CAPABILITY_SURFACE } from "./CatalogUi";

const DISCONNECTED: GithubConnection = {
  connectorId: "github",
  status: "disconnected",
};

export function GithubConnector({
  onConnectionChange,
}: {
  onConnectionChange?: (connected: boolean) => void;
}) {
  const [connection, setConnection] = useState<GithubConnection>(DISCONNECTED);
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
    if (!loading) onConnectionChange?.(connection.status === "connected");
  }, [connection.status, loading, onConnectionChange]);

  const saveCredential = async () => {
    if (!token.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await connectGithub({ token });
      setConnection(result.connection);
      setToken("");
      setEditingCredential(false);
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

  const connected = connection.status === "connected";

  return (
    <Card className={cn("overflow-hidden border-0 shadow-none", CAPABILITY_SURFACE)}>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
            <Github className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">GitHub</h3>
              {loading ? (
                <Badge variant="secondary"><Loader2 className="mr-1 size-3 animate-spin" />检测中</Badge>
              ) : connected ? (
                <Badge variant="secondary" className="text-success-ink">
                  <CircleCheck className="mr-1 size-3" />已连接
                </Badge>
              ) : (
                <Badge variant="outline">未连接</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              授权后，原生 Git、gh、SDK 和 Shell 在当前用户运行环境中直接可用。
            </p>
          </div>
        </div>

        {!loading && (!connected || editingCredential) && (
          <div className="space-y-2 rounded-xl bg-muted/20 p-3 ring-1 ring-border/60">
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
            <p className="text-xs text-muted-foreground">建议授予 repo、read:org 权限；凭据只保存到个人加密存储。</p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!loading && (
          <div className="flex flex-wrap justify-end gap-2">
            {connected && !editingCredential && (
              <Button variant="outline" size="sm" onClick={() => setEditingCredential(true)} disabled={saving}>
                更新凭据
              </Button>
            )}
            {connected && (
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void disconnect()} disabled={saving}>
                断开
              </Button>
            )}
            {(!connected || editingCredential) && (
              <>
                {editingCredential && (
                  <Button variant="ghost" size="sm" onClick={() => { setEditingCredential(false); setToken(""); }} disabled={saving}>
                    取消
                  </Button>
                )}
                <Button size="sm" onClick={() => void saveCredential()} disabled={saving || !token.trim()}>
                  {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                  {connected ? "保存新凭据" : "连接 GitHub"}
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
