import { useCallback, useEffect, useState } from "react";
import { ExternalLink, KeyRound, Loader2, RefreshCw, Save, Unplug } from "lucide-react";

import { authFetch } from "@/lib/authFetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CodexRuntimeStatus = {
  requestWindow: {
    limit: number;
    sampleCount: number;
    eligibleRequestCount: number;
    cacheHitRequestCount: number;
    eligibleInputTokens: number;
    cachedInputTokens: number;
    cacheHitRequestRate?: number;
    cachedInputTokenRate?: number;
  };
  lastRequestAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastModel?: string;
  oauth: {
    lastRefreshAt?: string;
    lastRefreshGeneration?: number;
    lastRefreshErrorAt?: string;
    lastRefreshError?: string;
  };
};

type CodexSubscriptionState = {
  config: {
    enabled: boolean;
    endpoint: string;
    originator: string;
  };
  credential: {
    configured: boolean;
    connected: boolean;
    accountBindingHash?: string;
    accountIdHint?: string;
    email?: string;
    expiresAt?: string;
    accessTokenExpired?: boolean;
    generation?: number;
    error?: string;
  };
  /** 蓝绿 N/N+1：旧 Server 尚未返回该字段时保持兼容。 */
  runtime?: CodexRuntimeStatus;
  warning?: string;
};

type DeviceSession = {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: string;
};

async function readJson<T>(response: Response): Promise<T & { error?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string };
}

export function CodexSubscriptionCard({ readOnly }: { readOnly: boolean }) {
  const [state, setState] = useState<CodexSubscriptionState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [deviceSession, setDeviceSession] = useState<DeviceSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyState = useCallback((next: CodexSubscriptionState) => {
    setState(next);
    setEnabled(next.config.enabled);
    setError(next.warning ?? null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch("/api/admin/codex-subscription");
      const data = await readJson<CodexSubscriptionState>(response);
      if (!response.ok || !data.config || !data.credential) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      applyState(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [applyState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!deviceSession) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await authFetch(
          `/api/admin/codex-subscription/device/${encodeURIComponent(deviceSession.sessionId)}`,
        );
        const data = await readJson<
          | { status: "pending"; retryAfterMs: number }
          | ({ status: "completed" } & CodexSubscriptionState)
          | { status: "expired" }
        >(response);
        if (cancelled) return;
        if (response.status === 410 || data.status === "expired") {
          setDeviceSession(null);
          setError("Codex 授权码已过期，请重新发起授权");
          return;
        }
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (data.status === "completed" && "config" in data && "credential" in data) {
          applyState(data);
          setDeviceSession(null);
          return;
        }
        if (data.status === "pending") {
          timer = setTimeout(poll, Math.max(1_000, data.retryAfterMs));
        }
      } catch (cause) {
        if (!cancelled) {
          setDeviceSession(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };

    timer = setTimeout(poll, Math.max(1_000, deviceSession.intervalSeconds * 1_000));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [applyState, deviceSession]);

  const startAuthorization = useCallback(async () => {
    setWorking(true);
    setError(null);
    try {
      const response = await authFetch("/api/admin/codex-subscription/device/start", {
        method: "POST",
      });
      const data = await readJson<DeviceSession>(response);
      if (!response.ok || !data.sessionId) throw new Error(data.error || `HTTP ${response.status}`);
      setDeviceSession(data);
      window.open(data.verificationUri, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }, []);

  const save = useCallback(async () => {
    setWorking(true);
    setError(null);
    try {
      const response = await authFetch("/api/admin/codex-subscription", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await readJson<CodexSubscriptionState>(response);
      if (!response.ok || !data.config || !data.credential) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      applyState(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }, [applyState, enabled]);

  const disconnect = useCallback(async () => {
    if (!window.confirm("确定断开 Codex 订阅账号并撤销已保存的 OAuth 凭据吗？")) return;
    setWorking(true);
    setError(null);
    try {
      const response = await authFetch("/api/admin/codex-subscription", { method: "DELETE" });
      const data = await readJson<CodexSubscriptionState>(response);
      if (!response.ok || !data.config || !data.credential) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      applyState(data);
      setDeviceSession(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }, [applyState]);

  return (
    <Card className="h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-1.5">
            <KeyRound className="size-4 text-muted-foreground" />
            Codex 订阅账号
          </span>
          {state?.credential.connected
            ? <Badge variant="secondary">已连接</Badge>
            : <Badge variant="outline">未连接</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !state ? (
          <div className="flex h-20 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              只提供 OpenAI Codex 订阅的原始 Responses transport。OAuth 凭据保存在 SecretVault；
              Agent 的 system prompt、工具定义、tool loop 与会话历史仍由本平台掌控。
            </p>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label>Endpoint</Label>
                <Input value={state?.config.endpoint ?? ""} disabled />
              </div>
              <div className="space-y-1.5">
                <Label>协议身份</Label>
                <Input value={state?.config.originator ?? ""} disabled />
              </div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={readOnly || working || !state?.credential.configured}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                启用订阅 transport
              </label>
            </div>

            {state?.credential.configured && (
              <div className="rounded-md border bg-muted/20 p-3 text-xs">
                <div>账号：{state.credential.email ?? `尾号 ${state.credential.accountIdHint ?? "未知"}`}</div>
                <div className="mt-1 text-muted-foreground">
                  绑定指纹：{state.credential.accountBindingHash ?? "未知"}
                  {state.credential.expiresAt
                    ? ` · access token ${state.credential.accessTokenExpired ? "已到期，将自动刷新" : `到期 ${new Date(state.credential.expiresAt).toLocaleString()}`}`
                    : ""}
                </div>
                {state.credential.error && <div className="mt-1 text-destructive">{state.credential.error}</div>}
              </div>
            )}

            {state?.runtime && (
              <div className="rounded-md border bg-muted/20 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">当前实例运行状态</span>
                  <span className="text-muted-foreground">
                    最近 {state.runtime.requestWindow.sampleCount}/{state.runtime.requestWindow.limit} 次
                  </span>
                </div>
                <div className="mt-2 grid gap-1 text-muted-foreground md:grid-cols-2">
                  <div>
                    缓存请求命中：
                    {state.runtime.requestWindow.eligibleRequestCount > 0
                      ? `${state.runtime.requestWindow.cacheHitRequestCount}/${state.runtime.requestWindow.eligibleRequestCount}（${formatRate(state.runtime.requestWindow.cacheHitRequestRate)}）`
                      : "暂无可判定请求"}
                  </div>
                  <div>
                    缓存 Token 比例：
                    {state.runtime.requestWindow.eligibleInputTokens > 0
                      ? `${state.runtime.requestWindow.cachedInputTokens.toLocaleString()}/${state.runtime.requestWindow.eligibleInputTokens.toLocaleString()}（${formatRate(state.runtime.requestWindow.cachedInputTokenRate)}）`
                      : "暂无可判定请求"}
                  </div>
                  <div>
                    最近成功：{formatTime(state.runtime.lastSuccessAt)}
                    {state.runtime.lastModel ? ` · ${state.runtime.lastModel}` : ""}
                  </div>
                  <div>
                    OAuth 最近刷新：{formatTime(state.runtime.oauth.lastRefreshAt)}
                    {state.runtime.oauth.lastRefreshGeneration
                      ? ` · generation ${state.runtime.oauth.lastRefreshGeneration}`
                      : ""}
                  </div>
                </div>
                {state.runtime.lastError && (
                  <div className="mt-2 text-destructive">
                    最近请求错误（{formatTime(state.runtime.lastErrorAt)}）：{state.runtime.lastError}
                  </div>
                )}
                {state.runtime.oauth.lastRefreshError && (
                  <div className="mt-1 text-destructive">
                    OAuth 刷新错误（{formatTime(state.runtime.oauth.lastRefreshErrorAt)}）：
                    {state.runtime.oauth.lastRefreshError}
                  </div>
                )}
                <p className="mt-2 text-muted-foreground">
                  此窗口随当前 Server 实例重启清空；跨实例与长期统计以运行事件和用量账本为准。
                </p>
              </div>
            )}

            {deviceSession && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                <p className="text-xs text-muted-foreground">在 OpenAI 页面输入以下一次性授权码：</p>
                <div className="mt-2 font-mono text-2xl font-semibold tracking-[0.25em]">
                  {deviceSession.userCode}
                </div>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => window.open(deviceSession.verificationUri, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="size-3.5" />
                  打开授权页面
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">页面完成后这里会自动刷新连接状态。</p>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly || working}
                onClick={startAuthorization}
              >
                {working ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                {state?.credential.configured ? "重新授权" : "连接 OpenAI 账号"}
              </Button>
              <Button size="sm" disabled={readOnly || working} onClick={save}>
                <Save className="size-3.5" />
                保存设置
              </Button>
              <Button size="sm" variant="ghost" disabled={working} onClick={refresh}>
                <RefreshCw className="size-3.5" />
                刷新
              </Button>
              {state?.credential.configured && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={readOnly || working}
                  onClick={disconnect}
                >
                  <Unplug className="size-3.5" />
                  断开并撤销
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatTime(value: string | undefined): string {
  return value ? new Date(value).toLocaleString() : "尚无";
}
