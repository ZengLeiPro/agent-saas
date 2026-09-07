import type { JwtPayload } from '../../auth/types.js';
import { isPlatformAdmin } from '../../auth/types.js';
import type { PgEntitlementStore } from '../../data/entitlements/store.js';
import type { KyAppInstallation } from '../systems/types.js';
import { KyAppInstallationError } from './service.js';

export function managementTenant(
  user: JwtPayload | undefined,
  requested?: string,
): string | undefined {
  if (!user) throw new KyAppInstallationError('需要登录', 'forbidden');
  if (isPlatformAdmin(user)) return requested;
  if (user.role !== 'admin' || !user.tenantId || (requested && requested !== user.tenantId)) {
    throw new KyAppInstallationError('只能管理本组织业务系统', 'forbidden');
  }
  return user.tenantId;
}

export async function installableScope(
  store: Pick<PgEntitlementStore, 'getEntitlementSet' | 'listResourceScopes'> | undefined,
  tenantId: string,
): Promise<(id: string) => boolean> {
  if (!store) throw new KyAppInstallationError('组织权益服务不可用', 'memberships_unavailable');
  const [set, scopes] = await Promise.all([
    store.getEntitlementSet(tenantId),
    store.listResourceScopes(tenantId),
  ]);
  const now = Date.now();
  const valid =
    set &&
    ['active', 'trial'].includes(set.status) &&
    (!set.effectiveFrom || Date.parse(set.effectiveFrom) <= now) &&
    (!set.effectiveTo || Date.parse(set.effectiveTo) > now);
  const scope = scopes.find((item) => item.resourceType === 'integrated_system');
  return (id) =>
    Boolean(valid && scope && (scope.mode === 'all' || (scope.mode === 'selected' && scope.resourceIds.includes(id))));
}

export function installationActions(
  user: JwtPayload,
  installation: Pick<KyAppInstallation, 'status' | 'tenantId'>,
): string[] {
  if (installation.status === 'deleted') return [];
  const platform = isPlatformAdmin(user);
  if (!platform && (user.role !== 'admin' || user.tenantId !== installation.tenantId)) return [];
  return [
    'diagnose',
    ...(installation.status === 'enabled' ? ['edit_assignments', 'disable'] : ['enable']),
    ...(platform
      ? [
          'verify_domain',
          'issue_credential',
          'switch_digest',
          'plan_offboarding',
          'execute_offboarding',
        ]
      : []),
  ];
}
