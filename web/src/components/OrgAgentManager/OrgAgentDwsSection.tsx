import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDwsAccount, AgentDwsAuthSession } from "@agent/shared";
import { CircleAlert, ExternalLink, Loader2, RefreshCw, RotateCw, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettingsDirtyEntry } from "@/components/PersonalSettings/dirtyRegistry";
import { authFetch } from "@/lib/authFetch";

export interface OrgAgentDwsSectionProps {
  tenantId: string;
  agentId: string;
  agentName: string;
}

interface AccountsResponse {
  accounts: AgentDwsAccount[];
}

interface AccountResponse {
  account: AgentDwsAccount;
}

interface AuthorizeResponse extends AccountResponse {
  session: AgentDwsAuthSession;
}

interface SessionResponse {
  session: AgentDwsAuthSession | null;
}

type StatusBadgeVariant = "success" | "warning" | "danger" | "info" | "muted";

const ACCOUNT_STATUS: Record<AgentDwsAccount["status"], { label: string; variant: StatusBadgeVariant }> = {
  draft: { label: "待授权", variant: "muted" },
  authorizing: { label: "授权中", variant: "warning" },
  active: { label: "已授权", variant: "success" },
  paused: { label: "已暂停", variant: "muted" },
  error: { label: "授权异常", variant: "danger" },
};

const RUNTIME_STATUS: Record<AgentDwsAccount["runtimeStatus"], { label: string; variant: StatusBadgeVariant }> = {
  stopped: { label: "已停止", variant: "muted" },
  starting: { label: "启动中", variant: "info" },
  ready: { label: "监听中", variant: "success" },
  error: { label: "监听异常", variant: "danger" },
};

const SESSION_STATUS: Record<AgentDwsAuthSession["status"], { label: string; variant: StatusBadgeVariant }> = {
  starting: { label: "准备授权", variant: "info" },
  awaiting_user: { label: "等待确认", variant: "warning" },
  connected: { label: "授权完成", variant: "success" },
  failed: { label: "授权失败", variant: "danger" },
  expired: { label: "授权已过期", variant: "muted" },
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload = await response.json() as { error?: unknown; message?: unknown };
    const message = typeof payload.error === "string"
      ? payload.error
      : typeof payload.message === "string" ? payload.message : fallback;
    return new Error(message);
  } catch {
    return new Error(`${fallback}（HTTP ${response.status}）`);
  }
}

async function requestAgentAccounts(tenantId: string, agentId: string): Promise<AgentDwsAccount[]> {
  const response = await authFetch(`/api/agent-dws-accounts?tenantId=${encodeURIComponent(tenantId)}`);
  if (!response.ok) throw await responseError(response, "读取钉钉成员账号失败");
  const payload = await response.json() as AccountsResponse;
  if (!Array.isArray(payload.accounts)) throw new Error("钉钉成员账号接口返回格式不正确");
  return payload.accounts.filter((account) => account.agentId === agentId);
}

function replaceAccount(accounts: AgentDwsAccount[], next: AgentDwsAccount): AgentDwsAccount[] {
  const exists = accounts.some((account) => account.accountId === next.accountId);
  return exists
    ? accounts.map((account) => account.accountId === next.accountId ? next : account)
    : [next, ...accounts];
}

function formatDateTime(value: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function eventKindsText(account: AgentDwsAccount): string {
  if (account.eventKinds.length === 0) return "暂无";
  return account.eventKinds
    .map((kind) => kind === "at_me" ? "@我的消息" : "全部单聊")
    .join("、");
}

export function OrgAgentDwsSection({ tenantId, agentId, agentName }: OrgAgentDwsSectionProps) {
  const [accounts, setAccounts] = useState<AgentDwsAccount[]>([]);
  const [sessions, setSessions] = useState<Record<string, AgentDwsAuthSession | null>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [loginId, setLoginId] = useState("");
  const [corpId, setCorpId] = useState("");

  const scopeRef = useRef({ tenantId, agentId });
  if (scopeRef.current.tenantId !== tenantId || scopeRef.current.agentId !== agentId) {
    scopeRef.current = { tenantId, agentId };
  }
  const sessionRequestsRef = useRef(new Set<string>());
  const pollingRef = useRef(new Set<string>());

  const refreshAccounts = useCallback(async () => {
    if (!tenantId.trim() || !agentId.trim()) return;
    const requestedScope = scopeRef.current;
    try {
      const next = await requestAgentAccounts(tenantId, agentId);
      if (scopeRef.current !== requestedScope) return;
      setAccounts(next);
      setActionError("");
    } catch (error) {
      if (scopeRef.current === requestedScope) {
        setActionError(errorMessage(error, "刷新钉钉成员账号失败"));
      }
    }
  }, [agentId, tenantId]);

  const pollAuthSession = useCallback(async (accountId: string) => {
    if (pollingRef.current.has(accountId)) return;
    const requestedTenantId = tenantId;
    const requestedScope = scopeRef.current;
    pollingRef.current.add(accountId);
    try {
      const response = await authFetch(
        `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/auth/session?tenantId=${encodeURIComponent(requestedTenantId)}`,
      );
      if (!response.ok) throw await responseError(response, "读取授权状态失败");
      const payload = await response.json() as SessionResponse;
      if (scopeRef.current !== requestedScope) return;
      const session = payload.session ?? null;
      setSessions((current) => ({ ...current, [accountId]: session }));
      if (!session) return;
      if (session.status === "connected") {
        setNotice(session.message || "账号授权已完成");
        setActionError("");
        await refreshAccounts();
      } else if (session.status === "failed" || session.status === "expired") {
        setActionError(session.message || "账号授权未完成，请重试");
      }
    } catch (error) {
      if (scopeRef.current !== requestedScope) return;
      setSessions((current) => ({ ...current, [accountId]: null }));
      setActionError(errorMessage(error, "读取授权状态失败"));
    } finally {
      pollingRef.current.delete(accountId);
      sessionRequestsRef.current.delete(accountId);
    }
  }, [refreshAccounts, tenantId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    setActionError("");
    setNotice("");
    setBusyAction(null);
    setCreating(false);
    setDisplayName("");
    setLoginId("");
    setCorpId("");
    setAccounts([]);
    setSessions({});
    sessionRequestsRef.current.clear();
    pollingRef.current.clear();

    if (!tenantId.trim() || !agentId.trim()) {
      setLoadError("缺少组织或企业专家 ID，无法读取钉钉成员账号");
      setLoading(false);
      return () => { cancelled = true; };
    }

    void requestAgentAccounts(tenantId, agentId)
      .then((next) => {
        if (!cancelled) setAccounts(next);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorMessage(error, "读取钉钉成员账号失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [agentId, tenantId]);

  useEffect(() => {
    for (const account of accounts) {
      if (account.status !== "authorizing") continue;
      if (Object.prototype.hasOwnProperty.call(sessions, account.accountId)) continue;
      if (sessionRequestsRef.current.has(account.accountId)) continue;
      sessionRequestsRef.current.add(account.accountId);
      void pollAuthSession(account.accountId);
    }
  }, [accounts, pollAuthSession, sessions]);

  useEffect(() => {
    const pendingIds = Object.entries(sessions)
      .filter(([, session]) => session?.status === "starting" || session?.status === "awaiting_user")
      .map(([accountId]) => accountId);
    if (pendingIds.length === 0) return;
    const timer = window.setInterval(() => {
      for (const accountId of pendingIds) void pollAuthSession(accountId);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [pollAuthSession, sessions]);

  const handleCreate = async () => {
    setActionError("");
    setNotice("");
    if (!tenantId.trim() || !agentId.trim()) {
      setActionError("缺少组织或企业专家 ID，无法创建钉钉成员账号");
      return false;
    }
    if (!displayName.trim() || !loginId.trim()) {
      setActionError("显示名和 loginId 均为必填项");
      return false;
    }

    const requestedScope = scopeRef.current;
    setCreating(true);
    try {
      const response = await authFetch("/api/agent-dws-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          agentId,
          displayName: displayName.trim(),
          loginId: loginId.trim(),
          ...(corpId.trim() ? { corpId: corpId.trim() } : {}),
          eventKinds: ["at_me", "all_direct"],
        }),
      });
      if (!response.ok) throw await responseError(response, "创建钉钉成员账号失败");
      const payload = await response.json() as AccountResponse;
      if (scopeRef.current !== requestedScope) return false;
      setAccounts((current) => replaceAccount(current, payload.account));
      setDisplayName("");
      setLoginId("");
      setCorpId("");
      setNotice("成员账号已创建，请发起 OAuth 授权");
      return true;
    } catch (error) {
      if (scopeRef.current === requestedScope) {
        setActionError(errorMessage(error, "创建钉钉成员账号失败"));
      }
      return false;
    } finally {
      if (scopeRef.current === requestedScope) setCreating(false);
    }
  };

  useSettingsDirtyEntry({
    id: `organization-agent-dws-create:${tenantId}:${agentId}`,
    label: `为 ${agentName} 创建钉钉成员账号`,
    dirty: Boolean(displayName || loginId || corpId),
    save: async () => { if (!await handleCreate()) throw new Error("Agent DWS account save failed"); },
    discard: () => { setDisplayName(""); setLoginId(""); setCorpId(""); setActionError(""); },
    draft: { displayName, loginId, corpId },
  });

  const handleAuthorize = async (account: AgentDwsAccount) => {
    const requestedTenantId = tenantId;
    const requestedScope = scopeRef.current;
    const actionKey = `${account.accountId}:authorize`;
    setBusyAction(actionKey);
    setActionError("");
    setNotice("");
    try {
      const response = await authFetch(
        `/api/agent-dws-accounts/${encodeURIComponent(account.accountId)}/authorize?tenantId=${encodeURIComponent(requestedTenantId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: account.revision }),
        },
      );
      if (!response.ok) throw await responseError(response, "发起 OAuth 授权失败");
      const payload = await response.json() as AuthorizeResponse;
      if (scopeRef.current !== requestedScope) return;
      setAccounts((current) => replaceAccount(current, payload.account));
      setSessions((current) => ({ ...current, [account.accountId]: payload.session }));
      setNotice(payload.session.message || "OAuth 授权已发起，请在授权页面完成确认");
    } catch (error) {
      if (scopeRef.current !== requestedScope) return;
      setActionError(errorMessage(error, "发起 OAuth 授权失败"));
      await refreshAccounts();
    } finally {
      if (scopeRef.current === requestedScope) setBusyAction(null);
    }
  };

  const handleEnabledChange = async (account: AgentDwsAccount, enabled: boolean) => {
    const requestedTenantId = tenantId;
    const requestedScope = scopeRef.current;
    const actionKey = `${account.accountId}:enabled`;
    setBusyAction(actionKey);
    setActionError("");
    setNotice("");
    try {
      const response = await authFetch(
        `/api/agent-dws-accounts/${encodeURIComponent(account.accountId)}?tenantId=${encodeURIComponent(requestedTenantId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: account.revision, enabled }),
        },
      );
      if (!response.ok) throw await responseError(response, enabled ? "启用账号失败" : "暂停账号失败");
      const payload = await response.json() as AccountResponse;
      if (scopeRef.current !== requestedScope) return;
      setAccounts((current) => replaceAccount(current, payload.account));
      if (!enabled) setSessions((current) => ({ ...current, [account.accountId]: null }));
      setNotice(enabled ? "账号已启用" : "账号已暂停");
    } catch (error) {
      if (scopeRef.current !== requestedScope) return;
      setActionError(errorMessage(error, enabled ? "启用账号失败" : "暂停账号失败"));
      await refreshAccounts();
    } finally {
      if (scopeRef.current === requestedScope) setBusyAction(null);
    }
  };

  const handleResetAuthorization = async (account: AgentDwsAccount) => {
    const requestedTenantId = tenantId;
    const requestedScope = scopeRef.current;
    const actionKey = `${account.accountId}:reset-auth`;
    setBusyAction(actionKey);
    setActionError("");
    setNotice("");
    try {
      const endpoint = `/api/agent-dws-accounts/${encodeURIComponent(account.accountId)}?tenantId=${encodeURIComponent(requestedTenantId)}`;
      const pauseResponse = await authFetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: account.revision, enabled: false }),
      });
      if (!pauseResponse.ok) throw await responseError(pauseResponse, "重置授权失败");
      const paused = await pauseResponse.json() as AccountResponse;
      const enableResponse = await authFetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: paused.account.revision, enabled: true }),
      });
      if (!enableResponse.ok) throw await responseError(enableResponse, "授权已暂停，但重新启用失败");
      const reset = await enableResponse.json() as AccountResponse;
      if (scopeRef.current !== requestedScope) return;
      setAccounts((current) => replaceAccount(current, reset.account));
      setSessions((current) => ({ ...current, [account.accountId]: null }));
      setNotice("授权状态已重置，可以重新发起 OAuth");
    } catch (error) {
      if (scopeRef.current !== requestedScope) return;
      setActionError(errorMessage(error, "重置授权失败"));
      await refreshAccounts();
    } finally {
      if (scopeRef.current === requestedScope) setBusyAction(null);
    }
  };

  const handleRestartStream = async (account: AgentDwsAccount) => {
    const requestedTenantId = tenantId;
    const requestedScope = scopeRef.current;
    const actionKey = `${account.accountId}:restart`;
    setBusyAction(actionKey);
    setActionError("");
    setNotice("");
    try {
      const response = await authFetch(
        `/api/agent-dws-accounts/${encodeURIComponent(account.accountId)}/restart-stream?tenantId=${encodeURIComponent(requestedTenantId)}`,
        { method: "POST" },
      );
      if (!response.ok) throw await responseError(response, "重启 Personal Stream 失败");
      let next: AgentDwsAccount = { ...account, runtimeStatus: "starting", lastError: null };
      try {
        const payload = await response.json() as Partial<AccountResponse>;
        if (payload.account) next = payload.account;
      } catch {
        // 202 响应允许没有 body，本地先显示启动中，后续可刷新读取真实状态。
      }
      if (scopeRef.current !== requestedScope) return;
      setAccounts((current) => replaceAccount(current, next));
      setNotice("Personal Stream 正在重启");
    } catch (error) {
      if (scopeRef.current === requestedScope) {
        setActionError(errorMessage(error, "重启 Personal Stream 失败"));
      }
    } finally {
      if (scopeRef.current === requestedScope) setBusyAction(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <UserRound className="size-4" />
              钉钉成员账号
            </CardTitle>
            <CardDescription>
              为「{agentName || agentId}」绑定独立成员身份，接收 @我的消息和全部单聊；不会创建钉钉通讯录成员。
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refreshAccounts()}
            disabled={loading || !tenantId.trim() || !agentId.trim()}
          >
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div className="flex gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-ink" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{loadError}</span>
          </div>
        ) : null}
        {actionError ? (
          <div className="flex gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-ink" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{actionError}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success-ink" role="status">
            {notice}
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取成员账号…
          </div>
        ) : accounts.length === 0 ? (
          <div
            className="space-y-4 rounded-lg border border-dashed p-4"
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
                event.preventDefault();
              }
            }}
          >
            <div>
              <div className="text-sm font-medium">添加专属成员账号</div>
              <p className="mt-1 text-xs text-muted-foreground">
                请先准备真实的钉钉成员账号。创建关联后，再发起 OAuth 授权。
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`org-agent-dws-display-name-${agentId}`}>显示名</Label>
                <Input
                  id={`org-agent-dws-display-name-${agentId}`}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="例如：销售助理账号"
                  maxLength={40}
                  disabled={creating}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`org-agent-dws-login-id-${agentId}`}>loginId</Label>
                <Input
                  id={`org-agent-dws-login-id-${agentId}`}
                  value={loginId}
                  onChange={(event) => setLoginId(event.target.value)}
                  placeholder="Agent 专属成员登录标识"
                  maxLength={128}
                  autoComplete="off"
                  disabled={creating}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`org-agent-dws-corp-id-${agentId}`}>corpId（可选）</Label>
              <Input
                id={`org-agent-dws-corp-id-${agentId}`}
                value={corpId}
                onChange={(event) => setCorpId(event.target.value)}
                placeholder="留空则在 OAuth 授权后识别"
                maxLength={512}
                autoComplete="off"
                disabled={creating}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">事件范围固定为：@我的消息、全部单聊。</span>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleCreate()}
                disabled={creating || !tenantId.trim() || !agentId.trim()}
              >
                {creating ? <Loader2 className="animate-spin" /> : null}
                创建账号
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {accounts.map((account) => {
              const accountStatus = ACCOUNT_STATUS[account.status];
              const runtimeStatus = RUNTIME_STATUS[account.runtimeStatus];
              const session = sessions[account.accountId];
              const sessionStatus = session ? SESSION_STATUS[session.status] : null;
              const authorizationPending = session?.status === "starting" || session?.status === "awaiting_user";
              const queryingSession = account.status === "authorizing"
                && !Object.prototype.hasOwnProperty.call(sessions, account.accountId);
              const rowBusy = busyAction?.startsWith(`${account.accountId}:`) ?? false;
              const authorizationNeedsReset = account.status === "authorizing"
                && !authorizationPending
                && !queryingSession;
              const authorizeLabel = authorizationPending || queryingSession
                ? "授权进行中"
                : authorizationNeedsReset
                  ? "重置授权"
                  : account.status === "active" ? "重新授权" : "发起 OAuth";
              const company = account.corpName || account.corpId || "授权后识别";

              return (
                <div key={account.accountId} className="space-y-4 rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{account.displayName}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{account.loginIdMasked}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {account.status === "paused" ? "已暂停" : "已启用"}
                      </span>
                      <Switch
                        type="button"
                        checked={account.status !== "paused"}
                        onCheckedChange={(enabled) => void handleEnabledChange(account, enabled)}
                        disabled={rowBusy}
                        aria-label={`${account.displayName}${account.status === "paused" ? "启用" : "暂停"}`}
                      />
                    </div>
                  </div>

                  <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <dt className="text-xs text-muted-foreground">公司</dt>
                      <dd className="mt-1 break-all">{company}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">授权状态</dt>
                      <dd className="mt-1"><Badge variant={accountStatus.variant}>{accountStatus.label}</Badge></dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Personal Stream</dt>
                      <dd className="mt-1"><Badge variant={runtimeStatus.variant}>{runtimeStatus.label}</Badge></dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">事件范围</dt>
                      <dd className="mt-1">{eventKindsText(account)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">最近事件</dt>
                      <dd className="mt-1">{formatDateTime(account.lastEventAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">钉钉成员</dt>
                      <dd className="mt-1">{account.dingtalkUserName || "授权后识别"}</dd>
                    </div>
                  </dl>

                  {sessionStatus && session ? (
                    <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={sessionStatus.variant}>{sessionStatus.label}</Badge>
                        {session.userCode ? <span className="font-mono text-xs">{session.userCode}</span> : null}
                      </div>
                      <p className="text-xs text-muted-foreground">{session.message}</p>
                      {session.status === "awaiting_user" && session.authorizationUrl ? (
                        <Button type="button" variant="link" size="sm" className="h-auto px-0 py-0" asChild>
                          <a href={session.authorizationUrl} target="_blank" rel="noreferrer">
                            打开授权页面 <ExternalLink className="size-3" />
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  ) : null}

                  {account.lastError ? (
                    <div className="flex gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger-ink" role="alert">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                      <span className="break-words">最近错误：{account.lastError}</span>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void (authorizationNeedsReset
                        ? handleResetAuthorization(account)
                        : handleAuthorize(account))}
                      disabled={rowBusy || account.status === "paused" || authorizationPending || queryingSession}
                    >
                      {busyAction === `${account.accountId}:authorize`
                        || busyAction === `${account.accountId}:reset-auth`
                        ? <Loader2 className="animate-spin" />
                        : null}
                      {authorizeLabel}
                    </Button>
                    {account.status === "active" && account.runtimeStatus === "error" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleRestartStream(account)}
                        disabled={rowBusy}
                      >
                        {busyAction === `${account.accountId}:restart`
                          ? <Loader2 className="animate-spin" />
                          : <RotateCw />}
                        重启监听
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default OrgAgentDwsSection;
