import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Database,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldOff,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/authFetch';

type Tab = 'clients' | 'connections' | 'operations';
interface ClientView {
  clientId: string;
  name: string;
  serviceAccountUserId: string;
  keyPrefix: string;
  effectiveStatus: string;
  allowedConnectionIds: string[];
  allowedAgentIds: string[];
  lastUsedAt?: string;
}
interface ConnectionView {
  connectionId: string;
  name: string;
  engine: string;
  status: string;
  allowedSchemas: string[];
  allowedTables: string[];
  lastTestedAt?: string;
  lastError?: { code: string };
}
interface UsageAggregate {
  key: string;
  executionCount: number;
  inputTokens: number;
  outputTokens: number;
  chargedCredits: number;
  revenueYuan: number;
  actualCostYuan?: number;
}
interface Operations {
  conversations: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
  queryAudit: Array<Record<string, unknown>>;
  usageSummary: null | {
    organization: UsageAggregate[];
    client: UsageAggregate[];
    account: UsageAggregate[];
    model: UsageAggregate[];
    connection: UsageAggregate[];
  };
  billingSummary: null | {
    balanceCredits: number;
    lowBalance: boolean;
    currentMonthCreditsUsed: number;
    currentMonthRevenueYuan: number;
    currentMonthActualCostYuan?: number;
  };
  budgetAlerts: Array<Record<string, unknown>>;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function ExternalAgentAdminPage({ tenantId: fixedTenantId }: { tenantId?: string }) {
  const [tenantId, setTenantId] = useState(fixedTenantId ?? '');
  const [tab, setTab] = useState<Tab>('clients');
  const [clients, setClients] = useState<ClientView[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [operations, setOperations] = useState<Operations>({
    conversations: [],
    executions: [],
    queryAudit: [],
    usageSummary: null,
    billingSummary: null,
    budgetAlerts: [],
  });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revealedKey, setRevealedKey] = useState('');
  const [clientDraft, setClientDraft] = useState({
    name: '',
    serviceAccountUserId: '',
    allowedAgentIds: '',
  });
  const [connectionDraft, setConnectionDraft] = useState({
    name: '',
    engine: 'postgresql',
    host: '',
    port: '5432',
    database: '',
    username: '',
    password: '',
    gatewayUrl: '',
    token: '',
    sslMode: 'verify-full',
    allowedSchemas: 'reporting',
    allowedTables: '',
    sensitiveColumns: '',
  });

  useEffect(() => {
    if (fixedTenantId !== undefined) setTenantId(fixedTenantId);
  }, [fixedTenantId]);
  const query = useMemo(
    () => (tenantId.trim() ? `?tenantId=${encodeURIComponent(tenantId.trim())}` : ''),
    [tenantId],
  );
  const load = useCallback(async () => {
    if (!tenantId.trim()) return;
    setLoading(true);
    setError('');
    try {
      const [clientData, connectionData, operationData] = await Promise.all([
        authFetch(`/api/admin/external-agent-clients${query}`).then((response) =>
          responseJson<{ clients: ClientView[] }>(response),
        ),
        authFetch(`/api/admin/external-database-connections${query}`).then((response) =>
          responseJson<{ connections: ConnectionView[] }>(response),
        ),
        authFetch(`/api/admin/external-agent-operations${query}`).then((response) =>
          responseJson<Operations>(response),
        ),
      ]);
      setClients(clientData.clients);
      setConnections(connectionData.connections);
      setOperations(operationData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [query, tenantId]);
  useEffect(() => {
    if (fixedTenantId && fixedTenantId.trim()) void load();
  }, [fixedTenantId, load]);

  const mutate = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const createClient = () =>
    mutate(async () => {
      const data = await authFetch('/api/admin/external-agent-clients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenantId.trim(),
          name: clientDraft.name,
          serviceAccountUserId: clientDraft.serviceAccountUserId,
          allowedAgentIds: splitList(clientDraft.allowedAgentIds),
        }),
      }).then((response) => responseJson<{ apiKey: string }>(response));
      setRevealedKey(data.apiKey);
      setClientDraft({ name: '', serviceAccountUserId: '', allowedAgentIds: '' });
    });
  const createConnection = () =>
    mutate(async () => {
      const common = {
        tenantId: tenantId.trim(),
        name: connectionDraft.name,
        engine: connectionDraft.engine,
        ssl_mode: connectionDraft.sslMode,
        allowed_schemas: splitList(connectionDraft.allowedSchemas),
        allowed_tables: splitList(connectionDraft.allowedTables),
        sensitive_columns: splitList(connectionDraft.sensitiveColumns),
      };
      const body =
        connectionDraft.engine === 'postgresql'
          ? {
              ...common,
              host: connectionDraft.host,
              port: Number(connectionDraft.port),
              database: connectionDraft.database,
              username: connectionDraft.username,
              password: connectionDraft.password,
            }
          : {
              ...common,
              gateway_url: connectionDraft.gatewayUrl,
              token: connectionDraft.token,
              ssl_mode: 'verify-full',
            };
      await authFetch('/api/admin/external-database-connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(responseJson);
      setConnectionDraft((current) => ({ ...current, name: '', password: '', token: '' }));
    });

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 overflow-auto pb-8">
      <div>
        <h1 className="text-xl font-semibold">外部 Agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理 API Client、只读数据连接和完整运行审计。密钥仅在创建或轮换后展示一次。
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4">
        <label className="min-w-64 flex-1 text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">组织 ID</span>
          <Input
            value={tenantId}
            disabled={fixedTenantId !== undefined}
            onChange={(event) => setTenantId(event.target.value)}
            placeholder="请输入目标组织 ID"
          />
        </label>
        <Button onClick={() => void load()} disabled={loading || !tenantId.trim()}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          刷新
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      {revealedKey ? (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="font-medium">请立即保存 API Key，关闭后无法再次查看</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-white/70 p-2">{revealedKey}</code>
            <Button
              variant="outline"
              size="icon"
              aria-label="复制 API Key"
              onClick={() => void navigator.clipboard.writeText(revealedKey)}
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex gap-1 border-b">
        {(
          [
            ['clients', 'API Client'],
            ['connections', '数据库连接'],
            ['operations', '会话与审计'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground'}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'clients' ? (
        <div className="space-y-4">
          <div className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-3">
            <Input
              aria-label="Client 名称"
              placeholder="Client 名称"
              value={clientDraft.name}
              onChange={(event) => setClientDraft({ ...clientDraft, name: event.target.value })}
            />
            <Input
              aria-label="专用账号 ID"
              placeholder="专用账号 ID"
              value={clientDraft.serviceAccountUserId}
              onChange={(event) =>
                setClientDraft({ ...clientDraft, serviceAccountUserId: event.target.value })
              }
            />
            <Input
              aria-label="组织 Agent ID"
              placeholder="允许的组织 Agent ID，逗号分隔"
              value={clientDraft.allowedAgentIds}
              onChange={(event) =>
                setClientDraft({ ...clientDraft, allowedAgentIds: event.target.value })
              }
            />
            <Button
              disabled={
                busy || !clientDraft.name || !clientDraft.serviceAccountUserId || !tenantId.trim()
              }
              onClick={() => void createClient()}
            >
              <KeyRound className="size-4" />
              创建并生成 Key
            </Button>
          </div>
          <div className="space-y-2">
            {clients.map((client) => (
              <div
                key={client.clientId}
                className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{client.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {client.clientId} · {client.keyPrefix} · 账号 {client.serviceAccountUserId}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    连接 {client.allowedConnectionIds.length} · 组织 Agent{' '}
                    {client.allowedAgentIds.length} · {client.effectiveStatus}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || client.effectiveStatus !== 'active'}
                  onClick={() =>
                    void mutate(async () => {
                      const data = await authFetch(
                        `/api/admin/external-agent-clients/${client.clientId}/rotate-key`,
                        { method: 'POST' },
                      ).then((response) => responseJson<{ apiKey: string }>(response));
                      setRevealedKey(data.apiKey);
                    })
                  }
                >
                  <RotateCcw className="size-3.5" />
                  轮换
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy || client.effectiveStatus !== 'active'}
                  onClick={() =>
                    void mutate(async () => {
                      await authFetch(
                        `/api/admin/external-agent-clients/${client.clientId}/revoke`,
                        { method: 'POST' },
                      ).then(responseJson);
                    })
                  }
                >
                  <ShieldOff className="size-3.5" />
                  撤销
                </Button>
              </div>
            ))}
            {clients.length === 0 ? (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                暂无 API Client
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {tab === 'connections' ? (
        <div className="space-y-4">
          <div className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-3">
            <Input
              aria-label="连接名称"
              placeholder="连接名称"
              value={connectionDraft.name}
              onChange={(event) =>
                setConnectionDraft({ ...connectionDraft, name: event.target.value })
              }
            />
            <select
              aria-label="连接类型"
              className="h-9 rounded-md border bg-card px-3 text-sm"
              value={connectionDraft.engine}
              onChange={(event) =>
                setConnectionDraft({ ...connectionDraft, engine: event.target.value })
              }
            >
              <option value="postgresql">PostgreSQL</option>
              <option value="gateway">HTTPS 查询网关</option>
            </select>
            {connectionDraft.engine === 'postgresql' ? (
              <>
                <Input
                  aria-label="数据库主机"
                  placeholder="主机"
                  value={connectionDraft.host}
                  onChange={(event) =>
                    setConnectionDraft({ ...connectionDraft, host: event.target.value })
                  }
                />
                <Input
                  aria-label="数据库名称"
                  placeholder="数据库"
                  value={connectionDraft.database}
                  onChange={(event) =>
                    setConnectionDraft({ ...connectionDraft, database: event.target.value })
                  }
                />
                <Input
                  aria-label="数据库用户名"
                  placeholder="只读用户名"
                  value={connectionDraft.username}
                  onChange={(event) =>
                    setConnectionDraft({ ...connectionDraft, username: event.target.value })
                  }
                />
                <Input
                  aria-label="数据库密码"
                  type="password"
                  placeholder="密码（仅本次提交）"
                  value={connectionDraft.password}
                  onChange={(event) =>
                    setConnectionDraft({ ...connectionDraft, password: event.target.value })
                  }
                />
              </>
            ) : (
              <>
                <Input
                  aria-label="查询网关地址"
                  placeholder="https://gateway.example/query"
                  value={connectionDraft.gatewayUrl}
                  onChange={(event) =>
                    setConnectionDraft({ ...connectionDraft, gatewayUrl: event.target.value })
                  }
                />
                <Input
                  aria-label="查询网关令牌"
                  type="password"
                  placeholder="网关 Token（仅本次提交）"
                  value={connectionDraft.token}
                  onChange={(event) =>
                    setConnectionDraft({ ...connectionDraft, token: event.target.value })
                  }
                />
              </>
            )}
            <Input
              aria-label="允许 Schema"
              placeholder="允许 Schema，逗号分隔"
              value={connectionDraft.allowedSchemas}
              onChange={(event) =>
                setConnectionDraft({ ...connectionDraft, allowedSchemas: event.target.value })
              }
            />
            <Input
              aria-label="允许数据表"
              placeholder="schema.table，逗号分隔"
              value={connectionDraft.allowedTables}
              onChange={(event) =>
                setConnectionDraft({ ...connectionDraft, allowedTables: event.target.value })
              }
            />
            <Input
              aria-label="敏感字段"
              placeholder="脱敏字段，逗号分隔"
              value={connectionDraft.sensitiveColumns}
              onChange={(event) =>
                setConnectionDraft({ ...connectionDraft, sensitiveColumns: event.target.value })
              }
            />
            <Button
              disabled={
                busy ||
                !connectionDraft.name ||
                splitList(connectionDraft.allowedTables).length === 0
              }
              onClick={() => void createConnection()}
            >
              <Database className="size-4" />
              登记并测试
            </Button>
          </div>
          <div className="space-y-2">
            {connections.map((connection) => (
              <div
                key={connection.connectionId}
                className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{connection.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {connection.connectionId} · {connection.engine} · {connection.status}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {connection.allowedTables.join('、') || '未配置数据表'}
                    {connection.lastError ? ` · ${connection.lastError.code}` : ''}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      await authFetch(
                        `/api/admin/external-database-connections/${connection.connectionId}/test`,
                        { method: 'POST' },
                      ).then(responseJson);
                    })
                  }
                >
                  <Play className="size-3.5" />
                  测试
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy || connection.status === 'revoked'}
                  onClick={() =>
                    void mutate(async () => {
                      await authFetch(
                        `/api/admin/external-database-connections/${connection.connectionId}/revoke`,
                        { method: 'POST' },
                      ).then(responseJson);
                    })
                  }
                >
                  <ShieldOff className="size-3.5" />
                  撤销
                </Button>
              </div>
            ))}
            {connections.length === 0 ? (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                暂无数据库连接
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {tab === 'operations' ? (
        <div className="space-y-4">
          {operations.billingSummary ? (
            <section className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground">积分余额</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">
                  {operations.billingSummary.balanceCredits.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">本月消耗积分</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">
                  {operations.billingSummary.currentMonthCreditsUsed.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">本月计费收入</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">
                  ¥{operations.billingSummary.currentMonthRevenueYuan.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">预算告警</div>
                <div
                  className={`mt-1 text-lg font-semibold ${operations.budgetAlerts.length ? 'text-destructive' : ''}`}
                >
                  {operations.budgetAlerts.length || '正常'}
                </div>
              </div>
            </section>
          ) : null}
          {operations.usageSummary ? (
            <section className="rounded-xl border bg-card p-4">
              <h2 className="font-medium">外部调用费用归因</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                沿用组织和专用账号预算门禁；按当前查询范围归因到 API
                Client、账号、模型与数据库连接。
              </p>
              <div className="mt-3 grid gap-4 lg:grid-cols-2">
                {(
                  [
                    ['API Client', operations.usageSummary.client],
                    ['专用账号', operations.usageSummary.account],
                    ['模型', operations.usageSummary.model],
                    ['数据库连接', operations.usageSummary.connection],
                  ] as const
                ).map(([title, rows]) => (
                  <div key={title}>
                    <h3 className="text-sm font-medium">{title}</h3>
                    <div className="mt-2 space-y-2">
                      {rows.map((row) => (
                        <div key={row.key} className="rounded-lg bg-muted/40 p-3 text-xs">
                          <div className="break-all font-medium">{row.key}</div>
                          <div className="mt-1 text-muted-foreground">
                            {row.executionCount} 次执行 ·{' '}
                            {(row.inputTokens + row.outputTokens).toLocaleString()} tokens ·{' '}
                            {row.chargedCredits.toFixed(2)} 积分 · ¥{row.revenueYuan.toFixed(2)}
                            {row.actualCostYuan === undefined
                              ? ''
                              : ` · 成本 ¥${row.actualCostYuan.toFixed(2)}`}
                          </div>
                        </div>
                      ))}
                      {rows.length === 0 ? (
                        <div className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                          暂无归因数据
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-3">
            {(
              [
                ['外部会话', operations.conversations, 'conversationId'],
                ['执行', operations.executions, 'executionId'],
                ['数据库查询审计', operations.queryAudit, 'auditId'],
              ] as const
            ).map(([title, rows, key]) => (
              <section key={title} className="rounded-xl border bg-card p-4">
                <h2 className="font-medium">
                  {title} <span className="text-xs text-muted-foreground">{rows.length}</span>
                </h2>
                <div className="mt-3 space-y-2">
                  {rows.slice(0, 50).map((row, index) => (
                    <div
                      key={String(row[key] ?? index)}
                      className="rounded-lg bg-muted/40 p-3 text-xs"
                    >
                      <div className="break-all font-medium">{String(row[key] ?? '')}</div>
                      <div className="mt-1 break-all text-muted-foreground">
                        {Object.entries(row)
                          .filter(
                            ([field]) =>
                              field !== key &&
                              [
                                'clientId',
                                'sessionId',
                                'runId',
                                'status',
                                'submissionStatus',
                                'connectionId',
                                'rowCount',
                                'durationMs',
                                'errorCode',
                              ].includes(field),
                          )
                          .map(([field, value]) => `${field}: ${String(value ?? '-')}`)
                          .join(' · ')}
                      </div>
                    </div>
                  ))}
                  {rows.length === 0 ? (
                    <div className="py-6 text-center text-sm text-muted-foreground">暂无记录</div>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
