import { installationPath } from '@/lib/kyAppManagementApi';
import { formatBusinessSystemTime } from './presentation';
import { ResourceState, useManagementResource } from './ManagementResource';

interface Activity {
  periodDays: number;
  callCount: number;
  userCount: number;
  successRate: number | null;
  failureCount: number;
  lastCalledAt: string | null;
  topCapabilities: Array<{ capabilityId: string; calls: number }>;
}

export function InstallationActivity({ installationId }: { installationId: string }) {
  const resource = useManagementResource<Activity>(installationPath(installationId, '/activity'));
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  const item = resource.data;
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
      <div>
        <h3 className="font-medium">最近 30 天调用情况</h3>
        <p className="text-xs text-muted-foreground">
          这里只统计调用与运行质量，组织费用统一在“用量与成本”查看。
        </p>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg bg-muted/40 p-3">
          <dt className="text-muted-foreground">调用次数</dt>
          <dd className="text-lg font-semibold">{item.callCount}</dd>
        </div>
        <div className="rounded-lg bg-muted/40 p-3">
          <dt className="text-muted-foreground">使用人数</dt>
          <dd className="text-lg font-semibold">{item.userCount}</dd>
        </div>
        <div className="rounded-lg bg-muted/40 p-3">
          <dt className="text-muted-foreground">成功率</dt>
          <dd className="text-lg font-semibold">
            {item.successRate === null ? '暂无' : `${Math.round(item.successRate * 100)}%`}
          </dd>
        </div>
        <div className="rounded-lg bg-muted/40 p-3">
          <dt className="text-muted-foreground">失败次数</dt>
          <dd className="text-lg font-semibold">{item.failureCount}</dd>
        </div>
        <div className="rounded-lg bg-muted/40 p-3">
          <dt className="text-muted-foreground">最近调用</dt>
          <dd>{formatBusinessSystemTime(item.lastCalledAt)}</dd>
        </div>
      </dl>
      {item.topCapabilities.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">能力排行</h4>
          <ul className="mt-1 text-sm">
            {item.topCapabilities.map((entry) => (
              <li key={entry.capabilityId}>
                {entry.capabilityId} · {entry.calls} 次
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
