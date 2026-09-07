import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { KyAppDeliveryHealthPanel } from '@/components/KyAppDeliveryPanels';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import type { InstallationPage } from '@/lib/kyAppManagementApi';
import { useManagementResource, ResourceState } from './ManagementResource';
import { InstallationDetail } from './InstallationDetail';
const routeId = 'platform.runtime.business-system-operations';
export function BusinessSystemOperationsPage({
  installationId,
}: {
  installationId?: string | null;
}) {
  const [filters, setFilters] = useState({ tenantId: '', systemId: '', status: '', signal: '' });
  const [cursor, setCursor] = useState('');
  const open = (id?: string) =>
    navigateGovernance(governanceRoute(routeId, id ? { entityId: id } : {}));
  const query = new URLSearchParams(
    Object.entries({ ...filters, cursor }).filter(([, value]) => value),
  );
  const resource = useManagementResource<InstallationPage>(`/installations?${query}`);
  if (installationId)
    return (
      <InstallationDetail
        key={installationId}
        installationId={installationId}
        onBack={() => open()}
      />
    );
  function filter(key: keyof typeof filters, value: string) {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setCursor('');
  }
  return (
    <section className="space-y-5 p-4">
      <h2 className="text-lg font-semibold">业务系统运营</h2>
      <div className="flex flex-wrap gap-3">
        {[
          ['tenantId', '组织标识'],
          ['systemId', '系统标识'],
        ].map(([key, label]) => (
          <label className="text-sm" key={key}>
            {label}
            <input
              className="ml-2 rounded border bg-background p-2"
              value={filters[key as 'tenantId' | 'systemId']}
              onChange={(event) => filter(key as 'tenantId' | 'systemId', event.target.value)}
            />
          </label>
        ))}
        <label className="text-sm">
          实例状态
          <select
            className="ml-2 rounded border bg-background p-2"
            value={filters.status}
            onChange={(event) => filter('status', event.target.value)}
          >
            <option value="">全部</option>
            <option value="enabled">已启用</option>
            <option value="pending">待处理</option>
            <option value="disabled">已停用</option>
            <option value="deleted">已删除</option>
          </select>
        </label>
        <label className="text-sm">
          异常类型
          <select
            className="ml-2 rounded border bg-background p-2"
            value={filters.signal}
            onChange={(event) => filter('signal', event.target.value)}
          >
            <option value="">全部</option>
            <option value="outcome_unknown">结果未知</option>
            <option value="rate_limited">调用受限</option>
            <option value="upstream_unavailable">服务不可用</option>
          </select>
        </label>
      </div>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <div className="space-y-2">
          {!resource.data.installations.length && <p>暂无符合条件的安装实例</p>}
          {resource.data.installations.map((item) => (
            <div
              key={item.installationId}
              className="flex items-center justify-between rounded border p-3"
            >
              <span>
                {item.systemName} · {item.tenantId} · {item.status} · {item.runtimeStatus}
              </span>
              <Button variant="outline" onClick={() => open(item.installationId)}>
                实例详情
              </Button>
            </div>
          ))}
          {cursor && (
            <Button variant="outline" onClick={() => setCursor('')}>
              返回首页
            </Button>
          )}
          {resource.data.nextCursor && (
            <Button variant="outline" onClick={() => setCursor(resource.data!.nextCursor!)}>
              下一页
            </Button>
          )}
        </div>
      )}
      <KyAppDeliveryHealthPanel
        tenantId={filters.tenantId}
        systemId={filters.systemId}
        onOpen={open}
      />
    </section>
  );
}
