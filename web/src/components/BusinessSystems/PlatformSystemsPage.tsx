import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { SystemActions } from './SystemActions';
import { businessStatusLabel } from './presentation';

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
      <header>
        <h2 className="flex items-center gap-2 font-semibold">
          <EntityIcons.businessSystem className="h-5 w-5" />
          业务系统
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">登记系统配置，并跟踪各组织的接入进度。</p>
      </header>
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
                <th>系统状态</th>
                <th>接入组织</th>
                <th>Agent 能力就绪</th>
                <th>需要处理</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.systems.map((system) => (
                <tr className="border-t" key={system.systemId}>
                  <td className="py-3">{system.name}</td>
                  <td>{catalogStatus(system)}</td>
                  <td>{system.metrics.installationCount}</td>
                  <td>{system.metrics.readyInstallationCount ?? 0}</td>
                  <td>
                    {system.metrics.actionRequiredInstallationCount ??
                      system.metrics.unhealthyInstallationCount}
                  </td>
                  <td>
                    <Button
                      variant="outline"
                      onClick={() =>
                        navigateGovernance(governanceRoute(routeId, { entityId: system.systemId }))
                      }
                    >
                      管理
                    </Button>
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">高级信息</summary>
                      <p>系统 ID：{system.systemId}</p>
                      <p>外部写能力：{system.metrics.externalWriteCapabilityCount}</p>
                    </details>
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

function catalogStatus(system: SystemDefinition & { metrics: SystemDetail['metrics'] }): string {
  if (!system.publishedDigest) return '待发布';
  if (system.status === 'disabled') return '已停用';
  if (system.status === 'retired') return '已退役';
  if ((system.metrics.actionRequiredInstallationCount ?? 0) > 0) return '部分异常';
  return '可接入';
}

function SystemDetailPage({ systemId }: { systemId: string }) {
  const resource = useManagementResource<SystemDetail>(`/systems/${encodeURIComponent(systemId)}`);
  const initial = new URLSearchParams(window.location.search).get('tab');
  const [tab, setTab] = useState(initial === 'installations' ? 'installations' : 'config');
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [settingsNotice, setSettingsNotice] = useState('');
  if (!resource.data)
    return (
      <section className="p-4">
        <Button variant="outline" onClick={() => navigateGovernance(governanceRoute(routeId))}>
          返回目录
        </Button>
        <ResourceState error={resource.error} retry={resource.reload} />
      </section>
    );
  const detail = resource.data;
  return (
    <section className="space-y-5 p-4">
      <Button variant="outline" onClick={() => navigateGovernance(governanceRoute(routeId))}>
        返回目录
      </Button>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{detail.definition.name}</h2>
          <p className="text-sm text-muted-foreground">
            {businessStatusLabel(detail.definition.status)} · 管理系统配置和组织接入。
          </p>
        </div>
        <SystemActions detail={detail} reload={resource.reload} />
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          const url = new URL(window.location.href);
          url.searchParams.set('tab', value === 'config' ? 'config' : value);
          window.history.replaceState(window.history.state, '', url);
        }}
      >
        <TabsList aria-label="业务系统管理">
          <TabsTrigger value="config">系统配置</TabsTrigger>
          <TabsTrigger value="installations">组织接入</TabsTrigger>
        </TabsList>
        <TabsContent value="config" className="space-y-4">
          <section className="rounded border p-4">
            <h3 className="font-medium">当前发布版本</h3>
            <p className="mt-1 text-sm">
              {detail.definition.publishedDigest
                ? `已发布 ${detail.definition.publishedDigest.slice(0, 10)}`
                : '尚未发布版本'}
            </p>
          </section>
          {settingsNotice && <p role="status">{settingsNotice}，不会自动修改已接入组织。</p>}
          <SystemConnectionSettings
            detail={detail}
            onSaved={() => {
              setConnectionRevision((value) => value + 1);
              setSettingsNotice('配置已保存');
            }}
          />
          <section className="rounded border p-4">
            <h3 className="font-medium">Agent 能力概览</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              已声明 {detail.metrics.capabilityCount} 项能力，其中{' '}
              {detail.metrics.externalWriteCapabilityCount} 项涉及外部写入。
            </p>
          </section>
          <details className="rounded border p-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
              历史版本与高级信息 <ChevronDown className="h-4 w-4" />
            </summary>
            <div className="mt-4 space-y-4">
              {detail.allowedActions?.includes('register_version') && (
                <ManifestUpload systemId={systemId} onRegistered={resource.reload} />
              )}
              <SystemVersions detail={detail} reload={resource.reload} />
              <p className="break-all text-xs text-muted-foreground">
                完整发布摘要：{detail.definition.publishedDigest ?? '暂无'}
              </p>
            </div>
          </details>
        </TabsContent>
        <TabsContent value="installations">
          <SystemDeliveryPage
            systemId={systemId}
            embedded
            connectionRevision={connectionRevision}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
