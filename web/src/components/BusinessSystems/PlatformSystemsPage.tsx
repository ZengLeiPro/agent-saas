import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { EntityIcons } from '@/lib/icons';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import { kyAppPost, KyAppManagementError, type SystemDefinition } from '@/lib/kyAppManagementApi';
import type { SystemDetail } from '@/lib/kyAppManagementTypes';
import { useManagementResource, ResourceState } from './ManagementResource';
import { ManifestUpload } from './ManifestUpload';
import { SystemVersions } from './SystemVersions';
const routeId = 'platform.resource-center.business-systems';
export function PlatformSystemsPage({ systemId }: { systemId?: string | null }) {
  return systemId ? <SystemDetailPage key={systemId} systemId={systemId} /> : <SystemCatalog />;
}
function SystemCatalog() {
  const resource = useManagementResource<{
    systems: Array<SystemDefinition & { metrics: SystemDetail['metrics'] }>;
    allowedActions?: string[];
  }>('/systems');
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  return (
    <section className="space-y-5 p-4">
      <h2 className="flex items-center gap-2 font-semibold">
        <EntityIcons.businessSystem className="h-5 w-5" />
        业务系统目录
      </h2>
      {resource.data.allowedActions?.includes('register_version') && (
        <ManifestUpload
          onRegistered={(id) => navigateGovernance(governanceRoute(routeId, { entityId: id }))}
        />
      )}
      {!resource.data.systems.length ? (
        <p>暂无业务系统</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>系统</th>
                <th>状态</th>
                <th>安装数</th>
                <th>异常实例</th>
                <th>外部写能力</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.systems.map((system) => (
                <tr className="border-t" key={system.systemId}>
                  <td className="py-3">
                    {system.name}
                    <div className="text-xs text-muted-foreground">{system.systemId}</div>
                  </td>
                  <td>{system.status}</td>
                  <td>{system.metrics.installationCount}</td>
                  <td>{system.metrics.unhealthyInstallationCount}</td>
                  <td>{system.metrics.externalWriteCapabilityCount}</td>
                  <td>
                    <Button
                      variant="outline"
                      onClick={() =>
                        navigateGovernance(governanceRoute(routeId, { entityId: system.systemId }))
                      }
                    >
                      详情与版本
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
function SystemDetailPage({ systemId }: { systemId: string }) {
  const resource = useManagementResource<SystemDetail>(`/systems/${encodeURIComponent(systemId)}`);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function status(next: 'disabled' | 'retired') {
    if (
      !resource.data ||
      busy ||
      !window.confirm(
        next === 'retired'
          ? '确认退役该系统？退役后不能恢复或发布新版本。'
          : '确认停用该业务系统？',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await kyAppPost(`/systems/${encodeURIComponent(systemId)}/status`, {
        status: next,
        expectedVersion: resource.data.definition.version,
      });
      resource.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
      if (reason instanceof KyAppManagementError && reason.status === 409) resource.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-5 p-4">
      <Button variant="outline" onClick={() => navigateGovernance(governanceRoute(routeId))}>
        返回目录
      </Button>
      {error && <p role="alert">{error}</p>}
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <>
          <h2 className="text-lg font-semibold">{resource.data.definition.name}</h2>
          <div className="flex gap-2">
            {resource.data.allowedActions?.includes('start_delivery') && (
              <Button
                onClick={() =>
                  navigateGovernance(
                    governanceRoute('platform.runtime.system-deliveries', {
                      search: `?systemId=${encodeURIComponent(systemId)}`,
                    }),
                  )
                }
              >
                创建组织交付
              </Button>
            )}
            {resource.data.allowedActions?.includes('disable_system') && (
              <Button variant="outline" disabled={busy} onClick={() => void status('disabled')}>
                停用系统
              </Button>
            )}
            {resource.data.allowedActions?.includes('retire_system') && (
              <Button variant="outline" disabled={busy} onClick={() => void status('retired')}>
                退役系统
              </Button>
            )}
          </div>
          {resource.data.allowedActions?.includes('register_version') && (
            <ManifestUpload systemId={systemId} onRegistered={resource.reload} />
          )}
          <SystemVersions detail={resource.data} reload={resource.reload} />
        </>
      )}
    </section>
  );
}
