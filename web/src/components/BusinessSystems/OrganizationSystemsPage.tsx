import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import type { InstallationPage, SystemDefinition } from '@/lib/kyAppManagementApi';
import { useManagementResource, ResourceState } from './ManagementResource';
import { InstallSystemWizard } from './InstallSystemWizard';
import { InstallationDetail } from './InstallationDetail';
const routeId = 'organization.agents.business-systems';
export function OrganizationSystemsPage({
  tenantId,
  installationId,
}: {
  tenantId: string;
  installationId?: string | null;
}) {
  const [tab, setTab] = useState('enabled');
  const [cursor, setCursor] = useState('');
  const open = (id?: string) =>
    navigateGovernance(
      governanceRoute(routeId, { orgId: tenantId, ...(id ? { entityId: id } : {}) }),
    );
  if (installationId)
    return (
      <InstallationDetail
        key={`${tenantId}:${installationId}`}
        tenantId={tenantId}
        installationId={installationId}
        onBack={() => open()}
      />
    );
  return (
    <section className="space-y-4 p-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="业务系统分类">
        {[
          ['enabled', '已安装'],
          ['installable', '可安装'],
          ['pending', '待处理'],
          ['disabled', '已停用'],
        ].map(([value, label]) => (
          <Button
            role="tab"
            aria-selected={tab === value}
            key={value}
            variant={tab === value ? 'default' : 'outline'}
            onClick={() => {
              setTab(value!);
              setCursor('');
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {tab === 'installable' ? (
        <InstallableSystems key={tenantId} tenantId={tenantId} onInstalled={open} />
      ) : (
        <InstallationList
          tenantId={tenantId}
          status={tab}
          cursor={cursor}
          onNext={setCursor}
          onOpen={open}
        />
      )}
    </section>
  );
}
function InstallationList({
  tenantId,
  status,
  cursor,
  onNext,
  onOpen,
}: {
  tenantId: string;
  status: string;
  cursor: string;
  onNext: (cursor: string) => void;
  onOpen: (id: string) => void;
}) {
  const resource = useManagementResource<InstallationPage>(
    `/installations?${new URLSearchParams({ tenantId, status, ...(cursor ? { cursor } : {}) })}`,
  );
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  return (
    <div className="space-y-3">
      {!resource.data.installations.length && <p>暂无此类业务系统</p>}
      {resource.data.installations.map((item) => (
        <div
          className="flex items-center justify-between rounded border p-4"
          key={item.installationId}
        >
          <div>
            {item.systemName}
            <p className="text-xs text-muted-foreground">
              {item.installationId} · {item.runtimeStatus}
            </p>
          </div>
          <Button variant="outline" onClick={() => onOpen(item.installationId)}>
            实例详情
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        {cursor && (
          <Button variant="outline" onClick={() => onNext('')}>
            返回首页
          </Button>
        )}
        {resource.data.nextCursor && (
          <Button variant="outline" onClick={() => onNext(resource.data!.nextCursor!)}>
            下一页
          </Button>
        )}
      </div>
    </div>
  );
}
function InstallableSystems({
  tenantId,
  onInstalled,
}: {
  tenantId: string;
  onInstalled: (id: string) => void;
}) {
  const resource = useManagementResource<{ systems: SystemDefinition[] }>(
    `/systems/installable?tenantId=${encodeURIComponent(tenantId)}`,
  );
  const [selected, setSelected] = useState('');
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  return (
    <div className="space-y-3">
      {!resource.data.systems.length && <p>暂无已授权且已发布的可安装系统</p>}
      {resource.data.systems.map((system) => (
        <div key={system.systemId} className="flex items-center justify-between rounded border p-3">
          <span>{system.name}</span>
          {system.allowedActions?.includes('install') && (
            <Button variant="outline" onClick={() => setSelected(system.systemId)}>
              安装
            </Button>
          )}
        </div>
      ))}
      {selected && (
        <InstallSystemWizard
          key={`${tenantId}:${selected}`}
          tenantId={tenantId}
          systemId={selected}
          onInstalled={onInstalled}
        />
      )}
    </div>
  );
}
