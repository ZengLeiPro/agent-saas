import { useManagementResource, ResourceState } from './BusinessSystems/ManagementResource';
import { Loader2, RefreshCw } from 'lucide-react';

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

export function KyAppTenantUsagePanel({ tenantId, installationId }: { tenantId: string; installationId?: string }) {
  const resource = useManagementResource<{ overview: UsageOverview }>(installationId ? `/installations/${encodeURIComponent(installationId)}/usage` : `/usage?tenantId=${encodeURIComponent(tenantId)}`);
  const data = resource.data?.overview; const error = resource.error; const load = resource.reload; const loading = !data;
  if (error) return <ResourceState error={error} retry={load} />;
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

/** 健康列表只展示交付指标，实例管理由业务系统运营页承接。 */
export function KyAppDeliveryHealthPanel({ onOpen, tenantId = '', systemId = '' }: { onOpen?: (id: string) => void; tenantId?: string; systemId?: string }) {
  const resource = useManagementResource<{ items: DeliveryHealth[] }>('/deliveries/health');
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  const items = resource.data.items.filter(item => (!tenantId || item.tenantId === tenantId) && (!systemId || item.systemId === systemId));
  return <section className="space-y-3"><h3 className="font-medium">交付健康概览</h3>{!items.length && <p>暂无符合条件的交付记录</p>}
    <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>组织</TableHead><TableHead>业务系统</TableHead><TableHead>每周活跃提问</TableHead><TableHead>预计剩余天数</TableHead><TableHead>最近调用</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{items.map(item => <TableRow key={item.installationId}><TableCell>{item.tenantName}</TableCell><TableCell>{item.systemId}</TableCell><TableCell>{item.weeklyActiveAskers} 人</TableCell><TableCell>{item.estimatedDaysRemaining ?? '暂无估算'}</TableCell><TableCell>{when(item.lastUsageAt)}</TableCell><TableCell>{onOpen && <Button variant="outline" onClick={() => onOpen(item.installationId)}>实例详情</Button>}</TableCell></TableRow>)}</TableBody></Table></div>
    <Button variant="outline" onClick={resource.reload}>刷新健康概览</Button></section>;
}
