import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import { authFetch } from '@/lib/authFetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface UsageOverview {
  currentMonthCreditsUsed: number;
  balanceCredits: number;
  estimatedDaysRemaining: number | null;
  topUsers: Array<{ userId: string; name: string; creditsUsed: number }>;
  topCapabilities: Array<{ capabilityId: string; calls: number }>;
  weeklyTrend: Array<{ date: string; creditsUsed: number }>;
  capabilityMetric: 'call_count';
}

interface DeliveryHealth {
  installationId: string;
  tenantId: string;
  tenantName: string;
  systemId: string;
  deliveredAt: string | null;
  loginPenetration: number;
  weeklyActiveAskers: number;
  consumptionRate: number;
  estimatedDaysRemaining: number | null;
  lastUsageAt: string | null;
  offboardingStatus: string;
}

interface InstallationDetail {
  installation: {
    status: string;
    registeredDigest: string | null;
    domainVerifiedAt: string | null;
  };
  runtime: {
    liveStatus: string;
    readyStatus: string;
    manifestDigest: string | null;
    lastError: string | null;
    directoryAgeSeconds: number | null;
    consecutiveFailures: number;
  } | null;
  digestConsistent: boolean;
}

interface CredentialMetadata {
  credentialId: string;
  status: string;
  ackedAt: string | null;
  expiresAt: string;
}

interface DiagnosticReport {
  checkedAt: string;
  passed: boolean;
  checks: Array<{ id: string; label: string; status: 'passed' | 'failed'; detail: string }>;
}

interface AuditEvent {
  auditId: string;
  action: string;
  result: string;
  actorUserId: string;
  occurredAt: string;
}

interface InstallationSignals {
  window: '24h';
  outcomeUnknown: number;
  rateLimited: number;
  upstreamUnavailable: number;
}

interface InstallationManagement {
  installation: {
    baseUrl: string;
    origin: string;
    techContactUserId: string;
    domainVerifiedAt: string | null;
  };
  definition: { name: string; status: string } | null;
  manifest: {
    description?: string;
    icon?: string;
    capabilities: Array<{ id: string; name: string; riskLevel: string; approval: string }>;
  } | null;
}

function credits(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function KyAppTenantUsagePanel({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch(
        `/api/app-contract/v1/usage?tenantId=${encodeURIComponent(tenantId)}`,
      );
      const body = (await response.json().catch(() => ({}))) as {
        overview?: UsageOverview;
        error?: { message?: string };
      };
      if (!response.ok || !body.overview)
        throw new Error(body.error?.message ?? '加载 AI 使用概览失败');
      setData(body.overview);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error)
    return (
      <div className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
        {error}
      </div>
    );
  if (!data)
    return loading ? (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载 AI 使用概览
      </div>
    ) : null;
  const warning =
    data.balanceCredits <= 0
      ? 'AI 积分已用完，定制软件仍可正常使用。请联系服务顾问续费。'
      : data.estimatedDaysRemaining !== null && data.estimatedDaysRemaining <= 3
        ? `按近 30 天使用速度，AI 积分预计还能使用 ${data.estimatedDaysRemaining} 天。请联系服务顾问续费。`
        : null;
  const maxTrend = Math.max(1, ...data.weeklyTrend.map((item) => item.creditsUsed));
  return (
    <Card data-testid="ky-app-tenant-usage">
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">AI 使用概览</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            能力排行按真实调用次数统计，不把一次 Run 成本重复分摊到每个能力。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {warning ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            {warning}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Metric label="本月消耗" value={credits(data.currentMonthCreditsUsed)} />
          <Metric label="剩余积分" value={credits(data.balanceCredits)} />
          <Metric
            label="预计可用"
            value={
              data.estimatedDaysRemaining === null
                ? '数据不足'
                : `${data.estimatedDaysRemaining} 天`
            }
            hint="按近 30 天日均消耗"
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-medium">使用人 Top 5</p>
            {data.topUsers.length ? (
              data.topUsers.map((item) => (
                <div key={item.userId} className="flex justify-between border-b py-2 text-sm">
                  <span>{item.name}</span>
                  <span className="tabular-nums">{credits(item.creditsUsed)}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">本月暂无消耗</p>
            )}
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">能力 Top 5</p>
            {data.topCapabilities.length ? (
              data.topCapabilities.map((item) => (
                <div key={item.capabilityId} className="flex justify-between border-b py-2 text-sm">
                  <span className="font-mono text-xs">{item.capabilityId}</span>
                  <span>{item.calls} 次</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">本月暂无能力调用</p>
            )}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">近 7 天趋势</p>
          <div className="flex h-24 items-end gap-2">
            {data.weeklyTrend.map((item) => (
              <div key={item.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-primary/70"
                  style={{ height: `${Math.max(2, (item.creditsUsed / maxTrend) * 64)}px` }}
                  title={`${item.date}：${credits(item.creditsUsed)}`}
                />
                <span className="text-[10px] text-muted-foreground">{item.date.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function KyAppDeliveryHealthPanel() {
  const [items, setItems] = useState<DeliveryHealth[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<InstallationDetail | null>(null);
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([]);
  const [diagnostic, setDiagnostic] = useState<DiagnosticReport | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [signals, setSignals] = useState<InstallationSignals | null>(null);
  const [management, setManagement] = useState<InstallationManagement | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch('/api/app-contract/v1/deliveries/health');
      const body = (await response.json().catch(() => ({}))) as {
        items?: DeliveryHealth[];
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? '加载交付客户健康度失败');
      setItems(body.items ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const inspect = async (installationId: string) => {
    setSelected(installationId);
    const [runtime, credentialList, auditList, managementResult, signalResult] = await Promise.all([
      authFetch(`/api/app-contract/v1/installations/${encodeURIComponent(installationId)}/runtime`),
      authFetch(
        `/api/app-contract/v1/installations/${encodeURIComponent(installationId)}/credentials`,
      ),
      authFetch(`/api/app-contract/v1/installations/${encodeURIComponent(installationId)}/audit`),
      authFetch(
        `/api/app-contract/v1/installations/${encodeURIComponent(installationId)}/management`,
      ),
      authFetch(`/api/app-contract/v1/installations/${encodeURIComponent(installationId)}/signals`),
    ]);
    const runtimeBody = await runtime.json().catch(() => ({}));
    const credentialsBody = await credentialList.json().catch(() => ({}));
    const auditBody = await auditList.json().catch(() => ({}));
    const managementBody = await managementResult.json().catch(() => ({}));
    const signalBody = await signalResult.json().catch(() => ({}));
    if (runtime.ok) setDetail(runtimeBody as InstallationDetail);
    if (credentialList.ok)
      setCredentials((credentialsBody as { credentials?: CredentialMetadata[] }).credentials ?? []);
    if (auditList.ok) setAuditEvents((auditBody as { events?: AuditEvent[] }).events ?? []);
    if (managementResult.ok) setManagement(managementBody as InstallationManagement);
    if (signalResult.ok)
      setSignals((signalBody as { signals?: InstallationSignals }).signals ?? null);
  };
  const diagnose = async (installationId: string) => {
    setDiagnosing(true);
    try {
      const response = await authFetch(
        `/api/app-contract/v1/installations/${encodeURIComponent(installationId)}/diagnose`,
        { method: 'POST' },
      );
      const body = (await response.json().catch(() => ({}))) as {
        report?: DiagnosticReport;
        error?: { message?: string };
      };
      if (!body.report) throw new Error(body.error?.message ?? '诊断未返回分项结果');
      setDiagnostic(body.report);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnosing(false);
    }
  };
  const changeStatus = async (installationId: string, action: 'enable' | 'disable') => {
    setChangingStatus(true);
    try {
      const response = await authFetch(
        `/api/app-contract/v1/installations/${encodeURIComponent(installationId)}/${action}`,
        { method: 'POST' },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? '更新安装状态失败');
      await Promise.all([inspect(installationId), load()]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChangingStatus(false);
    }
  };
  return (
    <Card data-testid="ky-app-delivery-health">
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">交付客户健康度</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            登录来自账号日志，提问和积分来自不可变账本，能力调用来自持久审计。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <div className="text-sm text-destructive">{error}</div> : null}
        <Table containerClassName="rounded-lg border">
          <TableHeader>
            <TableRow>
              <TableHead>组织 / 系统</TableHead>
              <TableHead>交付日</TableHead>
              <TableHead>登录渗透率</TableHead>
              <TableHead>周活跃提问</TableHead>
              <TableHead>消耗率</TableHead>
              <TableHead>距耗尽</TableHead>
              <TableHead>最近使用</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.installationId}>
                <TableCell>
                  <div className="font-medium">{item.tenantName}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.systemId} · {item.installationId}
                  </div>
                </TableCell>
                <TableCell>{when(item.deliveredAt)}</TableCell>
                <TableCell>{(item.loginPenetration * 100).toFixed(0)}%</TableCell>
                <TableCell>{item.weeklyActiveAskers} 人</TableCell>
                <TableCell>{(item.consumptionRate * 100).toFixed(0)}%</TableCell>
                <TableCell>
                  {item.estimatedDaysRemaining === null ? '—' : `${item.estimatedDaysRemaining} 天`}
                </TableCell>
                <TableCell>{when(item.lastUsageAt)}</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void inspect(item.installationId)}
                  >
                    运行状态
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {items.length === 0 && !loading ? (
          <p className="text-sm text-muted-foreground">暂无已登记交付客户。</p>
        ) : null}
        {selected && detail ? (
          <div className="space-y-4 rounded-lg border p-4 text-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                实例 {selected}
                <Badge variant="outline">{detail.installation.status}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void changeStatus(
                      selected,
                      detail.installation.status === 'enabled' ? 'disable' : 'enable',
                    )
                  }
                  disabled={changingStatus || detail.installation.status === 'deleted'}
                >
                  {changingStatus ? <Loader2 className="size-4 animate-spin" /> : null}
                  {detail.installation.status === 'enabled' ? '停用' : '启用'}
                </Button>
                <Button size="sm" onClick={() => void diagnose(selected)} disabled={diagnosing}>
                  {diagnosing ? <Loader2 className="size-4 animate-spin" /> : null}一键诊断
                </Button>
              </div>
            </div>
            {management ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-md border p-3">
                  <p className="font-medium">基本信息</p>
                  <p className="mt-1 text-muted-foreground">
                    {management.definition?.name ?? '未知系统'} · {management.installation.baseUrl}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    前端来源 {management.installation.origin} · 技术联系人{' '}
                    {management.installation.techContactUserId}
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="font-medium">展示</p>
                  <p className="mt-1 text-muted-foreground">
                    {management.manifest?.description ?? '未填写说明'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    图标 {management.manifest?.icon ?? '默认'} · 域名验证{' '}
                    {when(management.installation.domainVerifiedAt)}
                  </p>
                </div>
              </div>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-3">
              <Metric
                label="live / ready"
                value={`${detail.runtime?.liveStatus ?? 'unknown'} / ${detail.runtime?.readyStatus ?? 'unknown'}`}
              />
              <Metric
                label="digest"
                value={detail.digestConsistent ? '一致' : '不一致'}
                hint={detail.runtime?.manifestDigest?.slice(0, 12) ?? '尚未上报'}
              />
              <Metric
                label="凭据"
                value={`${credentials.filter((item) => item.status === 'active').length} 个有效`}
                hint={
                  credentials.length
                    ? `最近到期 ${when([...credentials].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0]?.expiresAt ?? null)}`
                    : '尚未签发'
                }
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              <Metric label="未知结果（24 小时）" value={String(signals?.outcomeUnknown ?? 0)} />
              <Metric label="限流（24 小时）" value={String(signals?.rateLimited ?? 0)} />
              <Metric
                label="暂不可用（24 小时）"
                value={String(signals?.upstreamUnavailable ?? 0)}
                hint="含熔断拒绝与上游 5xx"
              />
              <Metric
                label="证明失败（最近记录）"
                value={String(
                  auditEvents.filter((event) => event.action === 'ky_app.attest_failed').length,
                )}
                hint="来自治理审计，不代表全历史累计"
              />
            </div>
            {detail.runtime?.lastError ? (
              <p className="text-destructive">最近错误：{detail.runtime.lastError}</p>
            ) : null}
            {management?.manifest ? (
              <div>
                <p className="mb-2 font-medium">能力</p>
                <p className="mb-2 text-xs text-muted-foreground">
                  是否启用由业务系统角色权限页维护；平台展示登记值，审批级别只读。
                </p>
                {management.manifest.capabilities.map((capability) => (
                  <div
                    key={capability.id}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b py-2"
                  >
                    <span>
                      {capability.name}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {capability.id}
                      </span>
                    </span>
                    <Badge variant="outline">
                      {capability.riskLevel === 'read_only' ? '只读' : '写操作'}
                    </Badge>
                    <Badge variant="outline">
                      {capability.approval === 'required' ? '需确认' : '无需确认'}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : null}
            {diagnostic ? (
              <div>
                <div className="mb-2 flex items-center gap-2 font-medium">
                  诊断结果
                  <Badge variant={diagnostic.passed ? 'default' : 'destructive'}>
                    {diagnostic.passed ? '全部通过' : '存在失败'}
                  </Badge>
                  <span className="text-xs font-normal text-muted-foreground">
                    {when(diagnostic.checkedAt)}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {diagnostic.checks.map((check) => (
                    <div key={check.id} className="rounded-md border p-2">
                      <div className="flex items-center justify-between">
                        <span>{check.label}</span>
                        <Badge variant={check.status === 'passed' ? 'outline' : 'destructive'}>
                          {check.status === 'passed' ? '通过' : '失败'}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{check.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div>
              <p className="mb-2 font-medium">操作记录</p>
              {auditEvents.length ? (
                auditEvents.slice(0, 10).map((event) => (
                  <div
                    key={event.auditId}
                    className="grid grid-cols-[1fr_auto] gap-2 border-b py-2"
                  >
                    <span>
                      {event.action} · {event.actorUserId}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {event.result} · {when(event.occurredAt)}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">暂无该实例治理操作记录。</p>
              )}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
