import { useManagementResource, ResourceState } from './ManagementResource';
import { EntityIcons } from '@/lib/icons';
import type { SystemDefinition, InstallationPage } from '@/lib/kyAppManagementApi';
export function ManagementIndexPage({ tenantId }: { tenantId?: string }) {
  const resource = useManagementResource<
    { systems?: SystemDefinition[] } & Partial<InstallationPage>
  >(tenantId ? `/installations?tenantId=${encodeURIComponent(tenantId)}` : '/systems');
  return (
    <section className="space-y-4 p-4">
      <h2 className="flex items-center gap-2 font-semibold">
        <EntityIcons.businessSystem className="h-5 w-5" />
        业务系统
      </h2>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <ul>
          {(resource.data.systems ?? resource.data.installations ?? []).map((item) => (
            <li key={'installationId' in item ? item.installationId : item.systemId}>
              {'name' in item ? item.name : item.systemName} · {item.status}
            </li>
          ))}
          {!(resource.data.systems?.length || resource.data.installations?.length) && (
            <li>暂无业务系统</li>
          )}
        </ul>
      )}
    </section>
  );
}
