import { governanceAccessApi } from '@agent/shared/lib/governanceApi';
import { loadMySystems } from '@/lib/mySystemsSource';
const reason = '业务系统访问范围调整';
export function previewResourceAssignment<T>(
  resourceType: string,
  resourceId: string,
  command: Record<string, unknown>,
  tenantId: string,
): Promise<T> {
  return resourceType === 'system_installation'
    ? governanceAccessApi.previewAssignmentBatch<T>(
        { changes: [{ resourceType, resourceId, ...command }], reason },
        tenantId,
      )
    : governanceAccessApi.previewAssignment<T>(resourceType, resourceId, command, tenantId);
}
export async function updateResourceAssignment<T>(
  resourceType: string,
  resourceId: string,
  command: Record<string, unknown>,
  tenantId: string,
): Promise<T> {
  if (resourceType !== 'system_installation')
    return governanceAccessApi.updateAssignment<T>(resourceType, resourceId, command, tenantId);
  const { previewId, baselineDigest, expiresAt, ...change } = command;
  const receipt = await governanceAccessApi.updateAssignmentBatch<T>(
    {
      changes: [{ resourceType, resourceId, ...change }],
      reason,
      previewId,
      baselineDigest,
      expiresAt,
    },
    tenantId,
  );
  await loadMySystems({ force: true });
  return receipt;
}
export function AssignmentImpact({ preview }: { preview: { impact?: object } }) {
  const impact = preview.impact as
    { addedUserCount?: number; removedUserCount?: number; effectiveUserCount?: number } | undefined;
  if (impact?.addedUserCount === undefined || impact.removedUserCount === undefined) return null;
  return (
    <p className="text-sm">
      新增访问权 {impact.addedUserCount} 人，失去访问权 {impact.removedUserCount} 人，变更后有效成员{' '}
      {impact.effectiveUserCount} 人。Agent 能力将在新会话中生效。
    </p>
  );
}
