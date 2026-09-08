import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { EntityIcons } from '@/lib/icons';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import { type SystemDefinition } from '@/lib/kyAppManagementApi';
import type { SystemDetail } from '@/lib/kyAppManagementTypes';
import { useManagementResource, ResourceState } from './ManagementResource';
import { ManifestUpload } from './ManifestUpload';
import { SystemDeliveryPage } from '../SystemDelivery/SystemDeliveryPage';
import { SystemVersions } from './SystemVersions';
import { SystemConnectionSettings } from './SystemConnectionSettings';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SystemActions } from './SystemActions';
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
                      管理系统
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
  const [tab, setTab] = useState(() =>
    ['installations', 'connection-settings'].includes(
      new URLSearchParams(window.location.search).get('tab') ?? '',
    )
      ? new URLSearchParams(window.location.search).get('tab')!
      : 'versions',
  );
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [settingsNotice, setSettingsNotice] = useState('');
  return (
    <section className="space-y-5 p-4">
      <Button variant="outline" onClick={() => navigateGovernance(governanceRoute(routeId))}>
        返回目录
      </Button>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <>
          <header className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{resource.data.definition.name}</h2>
              <p className="text-sm text-muted-foreground">
                管理发布版本、接入配置和组织使用情况。
              </p>
              {resource.data.definition.status === 'disabled' && (
                <p className="text-sm">系统已停用，可在版本管理中重新发布恢复。</p>
              )}
              {resource.data.definition.status === 'retired' && (
                <p className="text-sm">系统已退役，历史记录保留。</p>
              )}
            </div>
            <SystemActions detail={resource.data} reload={resource.reload} />
          </header>
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(value);
              const url = new URL(window.location.href);
              url.searchParams.set('tab', value);
              window.history.replaceState(window.history.state, '', url);
            }}
          >
            <TabsList className="mb-4 w-fit" aria-label="业务系统管理">
              {[
                ['versions', '版本管理'],
                ['connection-settings', '接入配置'],
                ['installations', '组织接入'],
              ].map(([value, label]) => (
                <TabsTrigger key={value} value={value!}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent
              value="versions"
              forceMount
              hidden={tab !== 'versions'}
              className="space-y-4"
            >
              {resource.data.allowedActions?.includes('register_version') && (
                <ManifestUpload systemId={systemId} onRegistered={resource.reload} />
              )}
              <SystemVersions detail={resource.data} reload={resource.reload} />
            </TabsContent>
            <TabsContent value="connection-settings">
              {settingsNotice && <p role="status">{settingsNotice}</p>}
              <SystemConnectionSettings
                detail={resource.data}
                onSaved={() => {
                  setConnectionRevision((value) => value + 1);
                  setSettingsNotice('接入配置已保存');
                }}
              />
            </TabsContent>
            <TabsContent value="installations" forceMount hidden={tab !== 'installations'}>
              <SystemDeliveryPage
                systemId={systemId}
                embedded
                connectionRevision={connectionRevision}
              />
            </TabsContent>
          </Tabs>
        </>
      )}
    </section>
  );
}
