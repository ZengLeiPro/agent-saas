import type { GovernanceDependencyImpact } from '../routes/governanceImpactAuthority.js';
import type { AppRuntime } from './runtime.js';

/** 组织安装准入范围的影响清单；修改范围不删除既有安装或 Assignment。 */
export async function resolveRuntimeIntegratedSystemScopeImpact(
  runtime: Pick<AppRuntime, 'tenantStore' | 'kyAppSystemStore'>,
  tenantId: string,
): Promise<GovernanceDependencyImpact> {
  if (!runtime.tenantStore || !runtime.kyAppSystemStore?.listInstallationsForTenant) {
    throw new Error('Integrated system scope impact authority unavailable');
  }
  if (!runtime.tenantStore.findByIdStrict(tenantId)) throw new Error('Tenant not found');
  const installations = await runtime.kyAppSystemStore.listInstallationsForTenant(tenantId);
  return {
    affectedResources: installations
      .filter((item) => item.tenantId === tenantId && item.status !== 'deleted')
      .map((item) => ({
        type: 'app_installation',
        id: item.installationId,
        version: item.stateVersion,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    blockers: [],
  };
}
