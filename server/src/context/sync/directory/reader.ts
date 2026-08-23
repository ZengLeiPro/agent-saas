import type { PgMembershipStore } from '../../../data/memberships/store.js';
import type { UserStore } from '../../../data/users/store.js';
import { PLATFORM_TENANT_ID } from '../../../data/tenants/types.js';
import type { DirectoryContextReader, DirectoryPerson } from './types.js';

type DirectoryUserStore = Pick<UserStore, 'listAll' | 'findById'>;
type DirectoryMembershipStore = Pick<PgMembershipStore, 'listMemberships'>;

/** Reads the governance membership as authority and the local user directory only for safe display fields. */
export class GovernanceDirectoryContextReader implements DirectoryContextReader {
  constructor(
    private readonly users: DirectoryUserStore,
    private readonly memberships: DirectoryMembershipStore,
  ) {}

  async listTenantIds(): Promise<string[]> {
    return [...new Set(this.users.listAll().map(user => user.tenantId).filter(id => id !== PLATFORM_TENANT_ID))].sort();
  }

  async listPeople(tenantId: string): Promise<DirectoryPerson[]> {
    const memberships = await this.memberships.listMemberships(tenantId);
    return memberships.map(membership => {
      const user = this.users.findById(membership.userId);
      const disabled = membership.status !== 'active' || user?.disabled === true;
      return {
        tenantId,
        userId: membership.userId,
        username: user?.username ?? membership.userId,
        ...(user?.realName ? { displayName: user.realName } : {}),
        ...(user?.position ? { position: user.position } : {}),
        role: membership.persona,
        status: disabled ? 'disabled' : 'active',
        updatedAt: latestIso(membership.updatedAt, user?.updatedAt),
      };
    });
  }
}

function latestIso(left: string, right: string | undefined): string {
  if (!right) return new Date(left).toISOString();
  return new Date(Math.max(Date.parse(left), Date.parse(right))).toISOString();
}
