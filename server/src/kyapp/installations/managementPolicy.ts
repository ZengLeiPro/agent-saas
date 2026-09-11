import type { JwtPayload } from '../../auth/types.js';
import { isPlatformAdmin } from '../../auth/types.js';
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
