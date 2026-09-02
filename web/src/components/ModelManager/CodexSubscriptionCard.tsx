import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, KeyRound, Loader2, Plus, RefreshCw, Save, Trash2, Unplug } from "lucide-react";

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
  wireWindow?: {
    limit: number;
    sampleCount: number;
    websocketRequestCount: number;
    relayRequestCount: number;
    fallbackFullRequestCount: number;
    httpFallbackRequestCount: number;
    logicalRequestBodyBytes: number;
    wireRequestBodyBytes: number;
    savedRequestBodyBytes: number;
    savedRequestBodyRate?: number;
    lastFallbackReason?: string;
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

type CodexCredentialState = {
  id?: string;
  priority?: number;
  configured: boolean;
  connected: boolean;
  accountBindingHash?: string;
  accountIdHint?: string;
  email?: string;
  expiresAt?: string;
  accessTokenExpired?: boolean;
  generation?: number;
  availability?: "available" | "quota_cooldown" | "auth_unavailable";
  cooldownUntil?: string;
  lastFailureCode?: string;
  error?: string;
};

type CodexSubscriptionState = {
  config: {
    enabled: boolean;
    /** 蓝绿 N/N+1：旧 Server 缺字段时按关闭处理。 */
    websocketEnabled?: boolean;
    quotaCooldownMinutes?: number;
    endpoint: string;
    originator: string;
    credentialCount?: number;
  };
  /** 旧 Server 兼容别名；新接口使用 credentials。 */
  credential?: CodexCredentialState;
  credentials?: CodexCredentialState[];
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

export function formatCooldownRemaining(cooldownUntil: string): string {
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(cooldownUntil) - Date.now()) / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

function accountList(state: CodexSubscriptionState | null): CodexCredentialState[] {
  if (state?.credentials) return state.credentials;
  return state?.credential?.configured ? [state.credential] : [];
}

export function CodexSubscriptionCard({ readOnly }: { readOnly: boolean }) {
  const [state, setState] = useState<CodexSubscriptionState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [websocketEnabled, setWebsocketEnabled] = useState(false);
  const [quotaCooldownMinutes, setQuotaCooldownMinutes] = useState(60);
  const [deviceSession, setDeviceSession] = useState<DeviceSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyState = useCallback((next: CodexSubscriptionState) => {
    const credentials = next.credentials ?? (next.credential?.configured ? [next.credential] : []);
    setState({ ...next, credentials });
    setEnabled(next.config.enabled);
    setWebsocketEnabled(next.config.websocketEnabled === true);
    setQuotaCooldownMinutes(next.config.quotaCooldownMinutes ?? 60);
    setError(next.warning ?? null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch("/api/admin/codex-subscription");
      const data = await readJson<CodexSubscriptionState>(response);
      if (!response.ok || !data.config) {
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
    const hasUnavailableAccount = accountList(state)
      .some((account) => account.availability && account.availability !== "available");
    if (!hasUnavailableAccount) return;
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh, state]);

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
        if (data.status === "completed" && "config" in data) {
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

  const startAuthorization = useCallback(async (credentialRef?: string) => {
    setWorking(true);
    setError(null);
    try {
      const response = await authFetch("/api/admin/codex-subscription/device/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentialRef ? { credentialRef } : {}),
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
        body: JSON.stringify({ enabled, websocketEnabled, quotaCooldownMinutes }),
      });
      const data = await readJson<CodexSubscriptionState>(response);
      if (!response.ok || !data.config) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      applyState(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }, [applyState, enabled, quotaCooldownMinutes, websocketEnabled]);

  const reorder = useCallback(async (fromIndex: number, toIndex: number) => {
    const accounts = accountList(state);
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= accounts.length || toIndex >= accounts.length) return;
    const next = [...accounts];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    const refs = next.map((account) => account.id).filter((id): id is string => Boolean(id));
    if (refs.length !== accounts.length) {
      setError("当前服务端版本不支持多账号排序，请刷新后重试");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const response = await authFetch("/api/admin/codex-subscription/credentials/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialRefs: refs }),
      });
      const data = await readJson<CodexSubscriptionState>(response);
      if (!response.ok || !data.config) throw new Error(data.error || `HTTP ${response.status}`);
      applyState(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }, [applyState, state]);

  const removeCredential = useCallback(async (account: CodexCredentialState) => {
    if (!account.id) {
      setError("当前服务端版本不支持删除该授权账号，请刷新后重试");
      return;
    }
    const accountName = account.email ?? `尾号 ${account.accountIdHint ?? "未知"}`;
    if (!window.confirm(`确定删除 Codex 授权账号「${accountName}」吗？`)) return;
    setWorking(true);
    setError(null);
    try {
      const response = await authFetch(
        `/api/admin/codex-subscription/credentials/${encodeURIComponent(account.id)}`,
        { method: "DELETE" },
      );
      const data = await readJson<CodexSubscriptionState>(response);
      if (!response.ok || !data.config) throw new Error(data.error || `HTTP ${response.status}`);
      applyState(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }, [applyState]);

  const disconnect = useCallback(async () => {
    if (!window.confirm("确定断开全部 Codex 订阅账号并撤销已保存的 OAuth 凭据吗？")) return;
    setWorking(true);
    setError(null);
    try {
      const response = await authFetch("/api/admin/codex-subscription", { method: "DELETE" });
      const data = await readJson<CodexSubscriptionState>(response);
      if (!response.ok || !data.config) {
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

  const accounts = accountList(state);
  const primary = accounts[0] ?? state?.credential;
  const quotaCooldownValid = Number.isInteger(quotaCooldownMinutes)
    && quotaCooldownMinutes >= 1
    && quotaCooldownMinutes <= 10_080;

  return (
    <Card className="h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-1.5">
            <KeyRound className="size-4 text-muted-foreground" />
            Codex 订阅账号
          </span>
          {primary?.connected
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
              只提供 OpenAI Codex 订阅的原始 Responses 传输协议。OAuth 凭据保存在 SecretVault；
              Agent 的 system prompt、工具定义、tool loop 与会话历史仍由本平台掌控。
              账号按下方优先级使用；额度耗尽或明确授权失效时自动切换下一个。
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
                  disabled={readOnly || working || accounts.length === 0}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                启用订阅 transport
              </label>
              <div className="space-y-1.5">
                <Label htmlFor="codex-quota-cooldown">额度耗尽冷却（分钟）</Label>
                <Input
                  id="codex-quota-cooldown"
                  type="number"
                  min={1}
                  max={10_080}
                  value={quotaCooldownMinutes}
                  disabled={readOnly || working}
                  onChange={(event) => setQuotaCooldownMinutes(Number(event.target.value))}
                />
                <div className="text-xs text-muted-foreground">冷却期间跳过该账号，到期自动恢复探测。</div>
              </div>
              <label className="flex items-start gap-2 self-end pb-2 text-sm">
                <input
                  className="mt-0.5"
                  type="checkbox"
                  checked={websocketEnabled}
                  disabled={readOnly || working || !enabled || accounts.length === 0}
                  onChange={(event) => setWebsocketEnabled(event.target.checked)}
                />
                <span>
                  启用 WebSocket 会话接力
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    同一连接内只发送新增内容；状态不确定时自动回退完整历史，不改变 Token 核算。
                  </span>
                </span>
              </label>
            </div>

            {accounts.length > 0 && (
              <div className="space-y-2">
                <div>
                  <div className="text-sm font-medium">授权账号优先级</div>
                  <div className="text-xs text-muted-foreground">新顺序作用于后续模型请求，不改变已发出的请求。</div>
                </div>
                {accounts.map((account, index) => (
                  <div key={account.id ?? `${account.email ?? "account"}-${index}`} className="rounded-md border bg-muted/20 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">优先级 {index + 1}</Badge>
                        <span>{account.email ?? `尾号 ${account.accountIdHint ?? "未知"}`}</span>
                        {account.availability === "quota_cooldown"
                          ? <Badge variant="outline">额度冷却</Badge>
                          : account.availability === "auth_unavailable"
                            ? <Badge variant="destructive">需重授权</Badge>
                            : account.connected
                              ? <Badge variant="secondary">可用</Badge>
                              : <Badge variant="outline">异常</Badge>}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          disabled={readOnly || working || index === 0}
                          onClick={() => void reorder(index, index - 1)}
                          title="上移优先级"
                        >
                          <ArrowUp className="size-3.5" />
                          上移
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          disabled={readOnly || working || index === accounts.length - 1}
                          onClick={() => void reorder(index, index + 1)}
                          title="下移优先级"
                        >
                          <ArrowDown className="size-3.5" />
                          下移
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          disabled={readOnly || working || !account.id}
                          onClick={() => void startAuthorization(account.id)}
                        >
                          <KeyRound className="size-3.5" />
                          重授权
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-destructive hover:text-destructive"
                          disabled={readOnly || working || !account.id}
                          onClick={() => void removeCredential(account)}
                        >
                          <Trash2 className="size-3.5" />
                          删除
                        </Button>
                      </div>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      绑定指纹：{account.accountBindingHash ?? "未知"}
                      {account.expiresAt
                        ? ` · access token ${account.accessTokenExpired ? "已到期，将自动刷新" : `到期 ${new Date(account.expiresAt).toLocaleString()}`}`
                        : ""}
                    </div>
                    {account.availability === "quota_cooldown" && account.cooldownUntil && (
                      <div className="mt-1 text-amber-700 dark:text-amber-400">
                        冷却至 {new Date(account.cooldownUntil).toLocaleString()}
                        {` · 剩余 ${formatCooldownRemaining(account.cooldownUntil)}`}
                        {account.lastFailureCode ? ` · ${account.lastFailureCode}` : ""}
                      </div>
                    )}
                    {account.availability === "auth_unavailable" && (
                      <div className="mt-1 text-destructive">
                        授权不可用，请重授权{account.lastFailureCode ? ` · ${account.lastFailureCode}` : ""}
                      </div>
                    )}
                    {account.error && <div className="mt-1 text-destructive">{account.error}</div>}
                  </div>
                ))}
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
                      ? ` · 代次 ${state.runtime.oauth.lastRefreshGeneration}`
                      : ""}
                  </div>
                </div>
                {state.runtime.wireWindow && state.runtime.wireWindow.sampleCount > 0 && (
                  <div className="mt-2 grid gap-1 border-t pt-2 text-muted-foreground md:grid-cols-2">
                    <div>
                      WebSocket 接力：{state.runtime.wireWindow.relayRequestCount}/
                      {state.runtime.wireWindow.sampleCount}
                    </div>
                    <div>
                      请求体减少：{state.runtime.wireWindow.savedRequestBodyBytes.toLocaleString()} 字节
                      （{formatRate(state.runtime.wireWindow.savedRequestBodyRate)}）
                    </div>
                    <div>
                      全量重锚：{state.runtime.wireWindow.fallbackFullRequestCount}
                    </div>
                    <div>
                      HTTP/SSE 回退：{state.runtime.wireWindow.httpFallbackRequestCount}
                    </div>
                    {state.runtime.wireWindow.lastFallbackReason && (
                      <div className="md:col-span-2">
                        最近回退原因：{state.runtime.wireWindow.lastFallbackReason}
                      </div>
                    )}
                  </div>
                )}
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
                onClick={() => void startAuthorization()}
              >
                {working ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                添加授权账号
              </Button>
              <Button
                size="sm"
                disabled={readOnly || working || accounts.length === 0 || !quotaCooldownValid}
                onClick={() => void save()}
              >
                <Save className="size-3.5" />
                保存设置
              </Button>
              <Button size="sm" variant="ghost" disabled={working} onClick={() => void refresh()}>
                <RefreshCw className="size-3.5" />
                刷新
              </Button>
              {accounts.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={readOnly || working}
                  onClick={() => void disconnect()}
                >
                  <Unplug className="size-3.5" />
                  断开全部并撤销
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
