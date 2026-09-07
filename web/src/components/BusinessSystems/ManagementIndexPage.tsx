import { useManagementResource, ResourceState } from './ManagementResource';
import { EntityIcons } from '@/lib/icons';
import type { SystemDefinition, InstallationPage } from '@/lib/kyAppManagementApi';
export function ManagementIndexPage({ tenantId, deliveries = false }: { tenantId?: string; deliveries?: boolean }) {
  const resource = useManagementResource<
    { systems?: SystemDefinition[]; deliveries?: Array<{ installationId: string; systemId: string; offboardingStatus: string }> } & Partial<InstallationPage>
  >(tenantId ? `/installations?tenantId=${encodeURIComponent(tenantId)}` : deliveries ? '/deliveries' : '/systems');
  return (
    <section className="space-y-4 p-4">
      <h2 className="flex items-center gap-2 font-semibold">
        <EntityIcons.businessSystem className="h-5 w-5" />
        {deliveries ? '系统交付' : '业务系统'}
      </h2>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <ul>
          {(resource.data.systems ?? resource.data.installations ?? resource.data.deliveries ?? []).map((item) => (
            <li key={'installationId' in item ? item.installationId : item.systemId}>
              {'name' in item ? item.name : 'systemName' in item ? item.systemName : item.systemId} · {'status' in item ? item.status : item.offboardingStatus}
            </li>
          ))}
          {!(resource.data.systems?.length || resource.data.installations?.length || resource.data.deliveries?.length) && (
            <li>暂无业务系统</li>
          )}
        </ul>
      )}
    </section>
  );
}
