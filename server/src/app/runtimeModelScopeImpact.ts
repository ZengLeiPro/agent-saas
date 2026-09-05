import type { GovernanceDependencyImpact } from '../routes/governanceImpactAuthority.js';
import type { AppRuntime } from './runtime.js';

export async function resolveRuntimeModelScopeImpact(
  runtime: Pick<AppRuntime, 'tenantStore' | 'membershipStore' | 'agentResourceStore'>,
  tenantId: string,
): Promise<GovernanceDependencyImpact> {
  if (!runtime.tenantStore || !runtime.membershipStore || !runtime.agentResourceStore) {
    throw new Error('Model scope impact authority unavailable');
  }
  if (!runtime.tenantStore.findByIdStrict(tenantId)) throw new Error('Tenant not found');
  const [memberships, personalAgents, orgAgents] = await Promise.all([
    runtime.membershipStore.listMemberships(tenantId),
    runtime.agentResourceStore.listByKind('personal_agent', tenantId),
    runtime.agentResourceStore.listByKind('org_agent', tenantId),
  ]);
  // 模型范围是组织级运行策略；列出受策略约束的主体，不把改范围当作删除模型引用。
  const affectedResources = [
    ...memberships
      .filter((item) => item.tenantId === tenantId && item.status === 'active')
      .map((item) => ({ type: 'membership', id: item.userId, version: item.version })),
    ...[...personalAgents, ...orgAgents]
      .filter((item) => item.tenantId === tenantId && item.status === 'enabled')
      .map((item) => ({ type: item.kind, id: item.agentId, version: item.revision })),
  ].sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
  return { affectedResources, blockers: [] };
}
