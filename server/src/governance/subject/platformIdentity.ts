import { PLATFORM_TENANT_ID } from '../../data/tenants/types.js';

export type GovernanceHumanPersona = 'platform_admin' | 'org_admin' | 'member';

export function isActivePlatformAdminIdentity(
  tenantId: string | undefined,
  platformAdmin: { status: 'active' | 'disabled' } | null | undefined,
): boolean {
  return tenantId === PLATFORM_TENANT_ID && platformAdmin?.status === 'active';
}

export function governancePersonaForUser(user: {
  role: string;
  tenantId?: string;
}): GovernanceHumanPersona {
  if (user.role !== 'admin') return 'member';
  return user.tenantId === PLATFORM_TENANT_ID ? 'platform_admin' : 'org_admin';
}
