import { useState } from 'react';
import { ChevronDown, ChevronUp, FilePlus2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsPanelHeader } from '@/components/SettingsCenter/SettingsPanelHeader';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EntityIcons } from '@/lib/icons';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import { type SystemDefinition } from '@/lib/kyAppManagementApi';
import type { SystemDetail } from '@/lib/kyAppManagementTypes';
import { useManagementResource, ResourceState } from './ManagementResource';
import { ManifestUpload } from './ManifestUpload';
import { SystemDeliveryPage } from '../SystemDelivery/SystemDeliveryPage';
import { PublishVersionAction, SystemVersions } from './SystemVersions';
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
    <section className="space-y-5">
      <SettingsPanelHeader
        title="业务系统"
        description="登记系统配置，并跟踪各组织的接入进度。"
      />
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
  const [registerOpen, setRegisterOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
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
  const publishedVersion = detail.versions.find(
    (version) => version.digest === detail.definition.publishedDigest,
  );
  const publishableVersion = detail.versions.find(
    (version) =>
      version.allowedActions?.includes('publish_version') &&
      version.digest !== detail.definition.publishedDigest,
  );
  const releaseTarget =
    publishableVersion ?? (detail.definition.status === 'disabled' ? publishedVersion : undefined);
  const capabilities = (publishedVersion ?? detail.versions[0])?.manifest.capabilities ?? [];
  return (
    <section className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <Button
        variant="ghost"
        className="-ml-2"
        onClick={() => navigateGovernance(governanceRoute(routeId))}
      >
        返回目录
      </Button>
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-gradient-to-br from-brand-50/80 via-card to-card p-5 shadow-sm dark:from-brand-950/20 md:p-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
            <EntityIcons.businessSystem className="h-6 w-6" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold">{detail.definition.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {businessStatusLabel(detail.definition.status)} · {detail.metrics.installationCount}{' '}
              个组织实例
            </p>
          </div>
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
        <TabsList aria-label="业务系统管理" className="grid w-full max-w-sm grid-cols-2">
          <TabsTrigger value="config">系统配置</TabsTrigger>
          <TabsTrigger value="installations">组织接入</TabsTrigger>
        </TabsList>
        <TabsContent value="config" className="space-y-4">
          <section className="rounded-xl border bg-card p-4 shadow-sm md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="font-medium">版本发布</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  当前发布版本：
                  <span className="ml-1 font-mono text-foreground">
                    {detail.definition.publishedDigest?.slice(0, 10) ?? '暂无'}
                  </span>
                </p>
                {publishableVersion ? (
                  <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                    有待发布版本 {publishableVersion.digest.slice(0, 10)}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {detail.allowedActions?.includes('register_version') ? (
                  <Button variant="outline" onClick={() => setRegisterOpen(true)}>
                    <FilePlus2 className="mr-2 h-4 w-4" />
                    登记新版本
                  </Button>
                ) : null}
                <PublishVersionAction
                  detail={detail}
                  digest={releaseTarget?.digest}
                  reload={resource.reload}
                />
              </div>
            </div>
          </section>
          {settingsNotice && <p role="status">{settingsNotice}，不会自动修改已接入组织。</p>}
          <SystemConnectionSettings
            detail={detail}
            onSaved={() => {
              setConnectionRevision((value) => value + 1);
              setSettingsNotice('配置已保存');
            }}
          />
          <section className="rounded-xl border bg-card p-4 shadow-sm md:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-medium">Agent 能力</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  已声明 {detail.metrics.capabilityCount} 项能力，其中{' '}
                  {detail.metrics.externalWriteCapabilityCount} 项涉及外部写入。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCapabilitiesOpen((value) => !value)}
              >
                {capabilitiesOpen ? '收起能力' : '查看全部能力'}
                {capabilitiesOpen ? (
                  <ChevronUp className="ml-2 h-4 w-4" />
                ) : (
                  <ChevronDown className="ml-2 h-4 w-4" />
                )}
              </Button>
            </div>
            {capabilitiesOpen ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {capabilities.length ? (
                  capabilities.map((capability) => (
                    <article key={capability.id} className="rounded-lg border bg-muted/30 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <h4 className="font-medium">{capability.name}</h4>
                          <code className="text-xs text-muted-foreground">{capability.id}</code>
                        </div>
                        <span className="rounded-full bg-background px-2 py-1 text-xs">
                          {capability.riskLevel === 'external_write' ? '外部写入' : '只读'}
                        </span>
                      </div>
                      <p className="mt-3 text-sm text-muted-foreground">
                        {capability.description || '暂无能力说明'}
                      </p>
                    </article>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">当前版本未声明 Agent 能力。</p>
                )}
              </div>
            ) : null}
          </section>
          <details className="rounded-xl border bg-card p-4 shadow-sm">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
              历史版本与高级信息 <ChevronDown className="h-4 w-4" />
            </summary>
            <div className="mt-4 space-y-4">
              <SystemVersions detail={detail} />
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
      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>登记“{detail.definition.name}”新版本</DialogTitle>
            <DialogDescription>
              上传并校验新的 Manifest JSON；登记成功后仍需单独发布。
            </DialogDescription>
          </DialogHeader>
          <ManifestUpload
            systemId={systemId}
            onRegistered={() => {
              setRegisterOpen(false);
              resource.reload();
            }}
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}
