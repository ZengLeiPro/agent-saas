import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AgentDwsAccount, AgentDwsAuthSession } from "@agent/shared";
import { CircleAlert, ExternalLink, Loader2, Plus, RefreshCw, RotateCw, UserRound } from "lucide-react";

import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import {
  useSettingsDirtyEntry,
  useSettingsDirtyNavigation,
} from "@/components/PersonalSettings/dirtyRegistry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { authFetch } from "@/lib/authFetch";
import { ContextPolicyDialog } from './ContextPolicyDialog';
import { DelegationAccessPanel } from './DelegationAccessPanel';
import { GroupAgentWorkspacePanel } from './GroupAgentWorkspacePanel';

interface AgentDwsAccountsPageProps {
  tenantId: string;
}

interface OrgAgentOption {
  id: string;
  name: string;
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

async function requestAccounts(tenantId: string): Promise<AgentDwsAccount[]> {
  const response = await authFetch(`/api/agent-dws-accounts?tenantId=${encodeURIComponent(tenantId)}`);
  if (!response.ok) throw await responseError(response, "读取成员账号失败");
  const payload = await response.json() as AccountsResponse;
  if (!Array.isArray(payload.accounts)) throw new Error("成员账号接口返回格式不正确");
  return payload.accounts;
}

async function requestAgents(tenantId: string): Promise<OrgAgentOption[]> {
  const response = await authFetch(`/api/org-agents?tenantId=${encodeURIComponent(tenantId)}`);
  if (!response.ok) throw await responseError(response, "读取组织 Agent 失败");
  const payload = await response.json() as OrgAgentOption[] | { agents?: OrgAgentOption[] };
  const agents = Array.isArray(payload) ? payload : payload.agents;
  if (!Array.isArray(agents)) throw new Error("组织 Agent 接口返回格式不正确");
  return agents.filter((agent) => typeof agent.id === "string" && typeof agent.name === "string");
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
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function eventKindsText(account: AgentDwsAccount): string {
  return account.eventKinds.map((kind) => kind === "at_me" ? "@我的消息" : "全部单聊").join("、");
}

function contextPolicyText(account: AgentDwsAccount): { historical: string; realtime: string; other: string } {
  const historical = account.contextPolicy.historical;
  const realtime = account.contextPolicy.realtime;
  return {
    historical: historical.mode === 'none'
      ? '历史：不采集'
      : historical.mode === 'all'
        ? `历史：全部会话 · ${historical.lookbackDays} 天`
        : `历史：${historical.conversationIds.length} 个会话 · ${historical.lookbackDays} 天`,
    realtime: realtime.mode === 'none'
      ? '实时：不监听'
      : realtime.mode === 'all'
        ? '实时：全部会话'
        : `实时：${realtime.conversationIds.length} 个会话`,
    other: [
      account.contextPolicy.wiki?.enabled ? 'Wiki' : null,
      account.contextPolicy.minutes?.enabled
        ? `听记 ${account.contextPolicy.minutes.lookbackDays} 天`
        : null,
    ].filter(Boolean).join(' · ') || '文档/听记：不采集',
  };
}

export default function AgentDwsAccountsPage({ tenantId }: AgentDwsAccountsPageProps) {
  const requestDirtyNavigation = useSettingsDirtyNavigation();
  const [accounts, setAccounts] = useState<AgentDwsAccount[]>([]);
  const [agents, setAgents] = useState<OrgAgentOption[]>([]);
  const [sessions, setSessions] = useState<Record<string, AgentDwsAuthSession | null>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [agentId, setAgentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loginId, setLoginId] = useState("");
  const [corpId, setCorpId] = useState("");
  const [contextPolicyAccount, setContextPolicyAccount] = useState<AgentDwsAccount | null>(null);

  const tenantScopeRef = useRef({ tenantId });
  if (tenantScopeRef.current.tenantId !== tenantId) tenantScopeRef.current = { tenantId };
  const sessionRequestsRef = useRef(new Set<string>());
  const pollingRef = useRef(new Set<string>());

  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );

  const refreshAccounts = useCallback(async () => {
    if (!tenantId.trim()) return;
    const requestedScope = tenantScopeRef.current;
    try {
      const next = await requestAccounts(tenantId);
      if (tenantScopeRef.current !== requestedScope) return;
      setAccounts(next);
    } catch (error) {
      if (tenantScopeRef.current === requestedScope) {
        setActionError(errorMessage(error, "刷新成员账号失败"));
      }
    }
  }, [tenantId]);

  const pollAuthSession = useCallback(async (accountId: string) => {
    if (pollingRef.current.has(accountId)) return;
    const requestedTenantId = tenantId;
    const requestedScope = tenantScopeRef.current;
    pollingRef.current.add(accountId);
    try {
      const response = await authFetch(
        `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/auth/session?tenantId=${encodeURIComponent(requestedTenantId)}`,
      );
      if (!response.ok) throw await responseError(response, "读取授权状态失败");
      const payload = await response.json() as SessionResponse;
      if (tenantScopeRef.current !== requestedScope) return;
      const session = payload.session ?? null;
      setSessions((current) => ({ ...current, [accountId]: session }));
      if (!session) return;
      if (session.status === "connected") {
        setNotice(session.message || "账号授权已完成");
        await refreshAccounts();
      } else if (session.status === "failed" || session.status === "expired") {
        setActionError(session.message || "账号授权未完成，请重试");
      }
    } catch (error) {
      if (tenantScopeRef.current !== requestedScope) return;
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
    setCreateOpen(false);
    setCreateError("");
    setAgentId("");
    setDisplayName("");
    setLoginId("");
    setCorpId("");
    setContextPolicyAccount(null);
    setAccounts([]);
    setAgents([]);
    setSessions({});
    sessionRequestsRef.current.clear();
    pollingRef.current.clear();

    if (!tenantId.trim()) {
      setLoadError("缺少组织 ID，无法读取成员账号");
      setLoading(false);
      return () => { cancelled = true; };
    }

    const errors: string[] = [];
    void Promise.all([
      requestAccounts(tenantId)
        .then((next) => { if (!cancelled) setAccounts(next); })
        .catch((error) => { errors.push(errorMessage(error, "读取成员账号失败")); }),
      requestAgents(tenantId)
        .then((next) => { if (!cancelled) setAgents(next); })
        .catch((error) => { errors.push(errorMessage(error, "读取组织 Agent 失败")); }),
    ]).then(() => {
      if (cancelled) return;
      setLoadError(errors.join("；"));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [tenantId]);

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

  const resetCreateForm = () => {
    setAgentId("");
    setDisplayName("");
    setLoginId("");
    setCorpId("");
    setCreateError("");
  };

  const handleCreateOpenChange = (open: boolean) => {
    if (open) {
      setCreateOpen(true);
      return;
    }
    if (creating) return;
    requestDirtyNavigation(() => {
      setCreateOpen(false);
      resetCreateForm();
    });
  };

  const createAccount = async () => {
    setCreateError("");
    if (!agentId) {
      setCreateError("请选择要绑定的组织 Agent");
      return false;
    }
    if (!displayName.trim() || !loginId.trim()) {
      setCreateError("显示名和 loginId 均为必填项");
      return false;
    }

    const requestedScope = tenantScopeRef.current;
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
      if (!response.ok) throw await responseError(response, "创建成员账号失败");
      const payload = await response.json() as AccountResponse;
      if (tenantScopeRef.current !== requestedScope) return false;
      setAccounts((current) => replaceAccount(current, payload.account));
      setNotice("成员账号已创建，请在列表中发起 OAuth 授权");
      setActionError("");
      setCreateOpen(false);
      resetCreateForm();
      return true;
    } catch (error) {
      if (tenantScopeRef.current === requestedScope) {
        setCreateError(errorMessage(error, "创建成员账号失败"));
      }
      return false;
    } finally {
      if (tenantScopeRef.current === requestedScope) setCreating(false);
    }
  };
  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void createAccount();
  };
  useSettingsDirtyEntry({
    id: `organization-dws-account-create:${tenantId}`,
    label: "添加 Agent 钉钉成员账号",
    dirty: createOpen && Boolean(agentId || displayName || loginId || corpId),
    save: async () => { if (!await createAccount()) throw new Error("DWS account create failed"); },
    discard: resetCreateForm,
    draft: { agentId, displayName, loginId, corpId },
  });

  const handleAuthorize = async (account: AgentDwsAccount) => {
    const requestedTenantId = tenantId;
    const requestedScope = tenantScopeRef.current;
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
      if (tenantScopeRef.current !== requestedScope) return;
      setAccounts((current) => replaceAccount(current, payload.account));
      setSessions((current) => ({ ...current, [account.accountId]: payload.session }));
      setNotice(payload.session.message || "OAuth 授权已发起，授权页面准备好后请点击打开");
    } catch (error) {
      if (tenantScopeRef.current !== requestedScope) return;
      setActionError(errorMessage(error, "发起 OAuth 授权失败"));
      await refreshAccounts();
    } finally {
      if (tenantScopeRef.current === requestedScope) setBusyAction(null);
    }
  };

  const handleEnabledChange = async (account: AgentDwsAccount, enabled: boolean) => {
    const requestedTenantId = tenantId;
    const requestedScope = tenantScopeRef.current;
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
      if (tenantScopeRef.current !== requestedScope) return;
      setAccounts((current) => replaceAccount(current, payload.account));
      if (!enabled) setSessions((current) => ({ ...current, [account.accountId]: null }));
      setNotice(enabled ? "账号已启用" : "账号已暂停");
    } catch (error) {
      if (tenantScopeRef.current !== requestedScope) return;
      setActionError(errorMessage(error, enabled ? "启用账号失败" : "暂停账号失败"));
      await refreshAccounts();
    } finally {
      if (tenantScopeRef.current === requestedScope) setBusyAction(null);
    }
  };

  const handleResetAuthorization = async (account: AgentDwsAccount) => {
    const requestedTenantId = tenantId;
    const requestedScope = tenantScopeRef.current;
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
      if (tenantScopeRef.current !== requestedScope) return;
      setAccounts((current) => replaceAccount(current, reset.account));
      setSessions((current) => ({ ...current, [account.accountId]: null }));
      setNotice("授权状态已重置，可以重新发起 OAuth");
    } catch (error) {
      if (tenantScopeRef.current !== requestedScope) return;
      setActionError(errorMessage(error, "重置授权失败"));
      await refreshAccounts();
    } finally {
      if (tenantScopeRef.current === requestedScope) setBusyAction(null);
    }
  };

  const handleRestartStream = async (account: AgentDwsAccount) => {
    const requestedTenantId = tenantId;
    const requestedScope = tenantScopeRef.current;
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
        // 202 响应允许没有 body，本地先显示启动中，后续刷新读取真实状态。
      }
      if (tenantScopeRef.current !== requestedScope) return;
      setAccounts((current) => replaceAccount(current, next));
      setNotice("Personal Stream 正在重启");
    } catch (error) {
      if (tenantScopeRef.current === requestedScope) {
        setActionError(errorMessage(error, "重启 Personal Stream 失败"));
      }
    } finally {
      if (tenantScopeRef.current === requestedScope) setBusyAction(null);
    }
  };

  const handleContextPolicySaved = (account: AgentDwsAccount) => {
    setAccounts(current => replaceAccount(current, account));
    setContextPolicyAccount(account);
    setActionError('');
    setNotice('Context 范围已更新');
  };

  return (
    <div className="space-y-5">
      <SettingsPanelHeader
        title="Agent 钉钉成员账号"
        description="为组织 Agent 绑定独立钉钉成员身份，并管理 OAuth、Personal Stream 与会话回复。"
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => void refreshAccounts()} disabled={loading}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              添加成员账号
            </Button>
          </>
        )}
      />

      <div className="flex gap-3 rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-sm" role="note">
        <UserRound className="mt-0.5 size-4 shrink-0 text-info-ink" />
        <div>
          <p className="font-medium">这是独立成员账号，不是机器人</p>
          <p className="mt-0.5 text-muted-foreground">
            请使用专门分配给 Agent 的钉钉成员身份授权；这里只配置关联，不会自动创建钉钉通讯录账号，也不会展示 OAuth token 或凭据引用。
          </p>
        </div>
      </div>

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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>成员账号</CardTitle>
          <CardDescription>每个账号只服务于一个组织 Agent；授权后，消息会持久路由到该 Agent 的会话，并以成员身份回复。</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在读取成员账号…
            </div>
          ) : accounts.length === 0 ? (
            <div className="py-14 text-center text-sm text-muted-foreground">
              暂无成员账号，请先添加并完成 OAuth 授权。
            </div>
          ) : (
            <Table containerClassName="max-h-[65vh]">
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>账号</TableHead>
                  <TableHead>授权状态</TableHead>
                  <TableHead>Personal Stream</TableHead>
                  <TableHead>事件范围</TableHead>
                  <TableHead>Context 范围</TableHead>
                  <TableHead>最近事件</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
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
                  const contextScope = contextPolicyText(account);

                  return (
                    <TableRow key={account.accountId}>
                      <TableCell className="min-w-36">
                        <div className="font-medium">{agentNames.get(account.agentId) || account.agentId}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{account.agentId}</div>
                      </TableCell>
                      <TableCell className="min-w-40">
                        <div className="font-medium">{account.displayName}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{account.loginIdMasked}</div>
                        {account.corpName || account.dingtalkUserName ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {[account.corpName, account.dingtalkUserName].filter(Boolean).join(" · ")}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-48 align-top">
                        <Badge variant={accountStatus.variant}>{accountStatus.label}</Badge>
                        {sessionStatus && session ? (
                          <div className="mt-2 space-y-1">
                            <Badge variant={sessionStatus.variant}>{sessionStatus.label}</Badge>
                            <p className="max-w-64 whitespace-normal text-xs text-muted-foreground">{session.message}</p>
                            {session.status === "awaiting_user" && session.authorizationUrl ? (
                              <Button variant="link" size="sm" className="h-auto px-0 py-0" asChild>
                                <a href={session.authorizationUrl} target="_blank" rel="noreferrer">
                                  打开授权页面 <ExternalLink className="size-3" />
                                </a>
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-44 align-top">
                        <Badge variant={runtimeStatus.variant}>{runtimeStatus.label}</Badge>
                        {account.lastError ? (
                          <p className="mt-2 max-w-64 whitespace-normal break-words text-xs text-danger-ink">
                            {account.lastError}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-36 whitespace-normal text-xs text-muted-foreground">
                        {eventKindsText(account)}
                      </TableCell>
                      <TableCell className="min-w-48 whitespace-normal text-xs text-muted-foreground">
                        <div>{contextScope.historical}</div>
                        <div className="mt-1">{contextScope.realtime}</div>
                        <div className="mt-1">{contextScope.other}</div>
                      </TableCell>
                      <TableCell className="min-w-28 text-xs text-muted-foreground">
                        {formatDateTime(account.lastEventAt)}
                      </TableCell>
                      <TableCell className="min-w-60">
                        <div className="flex flex-col items-end gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {account.status === "paused" ? "已暂停" : "已启用"}
                            </span>
                            <Switch
                              checked={account.status !== "paused"}
                              onCheckedChange={(enabled) => void handleEnabledChange(account, enabled)}
                              disabled={rowBusy}
                              aria-label={`${account.displayName}${account.status === "paused" ? "启用" : "暂停"}`}
                            />
                          </div>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setContextPolicyAccount(account)}
                              disabled={rowBusy}
                            >
                              配置 Context
                            </Button>
                            <Button
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
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <DelegationAccessPanel tenantId={tenantId} accounts={accounts} />
      <GroupAgentWorkspacePanel tenantId={tenantId} accounts={accounts} />

      <ContextPolicyDialog
        account={contextPolicyAccount}
        tenantId={tenantId}
        open={contextPolicyAccount !== null}
        onOpenChange={(open) => { if (!open) setContextPolicyAccount(null); }}
        onSaved={handleContextPolicySaved}
      />

      <Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
        <DialogContent>
          <form onSubmit={(event) => void handleCreate(event)} className="space-y-5">
            <DialogHeader>
              <DialogTitle>添加 Agent 成员账号</DialogTitle>
              <DialogDescription>
                这里只创建平台内的账号关联配置，不会自动新建钉钉通讯录成员。请先准备真实专属账号，再从列表发起 OAuth 授权。
              </DialogDescription>
            </DialogHeader>

            {createError ? (
              <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-ink" role="alert">
                {createError}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="agent-dws-agent">组织 Agent</Label>
              <Select value={agentId} onValueChange={setAgentId} disabled={agents.length === 0 || creating}>
                <SelectTrigger id="agent-dws-agent" aria-label="组织 Agent">
                  <SelectValue placeholder="选择 Agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {agents.length === 0 ? <p className="text-xs text-muted-foreground">当前组织没有可选 Agent。</p> : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="agent-dws-display-name">显示名</Label>
                <Input
                  id="agent-dws-display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="例如：销售助理账号"
                  maxLength={40}
                  required
                  disabled={creating}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-dws-login-id">loginId</Label>
                <Input
                  id="agent-dws-login-id"
                  value={loginId}
                  onChange={(event) => setLoginId(event.target.value)}
                  placeholder="Agent 专属成员登录标识"
                  maxLength={128}
                  required
                  autoComplete="off"
                  disabled={creating}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="agent-dws-corp-id">corpId（可选）</Label>
              <Input
                id="agent-dws-corp-id"
                value={corpId}
                onChange={(event) => setCorpId(event.target.value)}
                placeholder="留空则在 OAuth 授权后识别"
                maxLength={512}
                autoComplete="off"
                disabled={creating}
              />
            </div>

            <div className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              事件范围固定为：@我的消息、全部单聊。
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleCreateOpenChange(false)} disabled={creating}>
                取消
              </Button>
              <Button type="submit" disabled={creating || agents.length === 0}>
                {creating ? <Loader2 className="animate-spin" /> : <Plus />}
                创建账号
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
