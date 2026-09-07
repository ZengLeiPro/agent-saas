import { OrganizationAssignmentManager } from '@/components/OrganizationGovernance/ResourceAccessEditors';
export function InstallationAssignments({
  tenantId,
  installationId,
  name,
}: {
  tenantId: string;
  installationId: string;
  name: string;
}) {
  return (
    <OrganizationAssignmentManager
      key={`${tenantId}:${installationId}`}
      tenantId={tenantId}
      resourceType="system_installation"
      title="业务系统成员、部门与 Agent 授权"
      items={[{ resourceId: installationId, label: name }]}
    />
  );
}
