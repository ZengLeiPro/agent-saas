import type { PlatformAdmin, TenantMembership } from '../../data/memberships/types.js';
import type { UserRecord, UserStore } from '../../data/users/index.js';
import { PLATFORM_TENANT_ID } from '../../data/tenants/types.js';

interface MembershipReader {
  getMembership(tenantId: string, userId: string): Promise<TenantMembership | null>;
  getPlatformAdmin(userId: string): Promise<PlatformAdmin | null>;
}
import type { HumanSubjectContext, ServiceSubjectContext } from './types.js';
import { SubjectResolutionError } from './types.js';

function accountStatus(user: UserRecord): 'active' | 'disabled' {
  return user.disabled === true ? 'disabled' : 'active';
}

export class SubjectResolver {
  constructor(
    private readonly userStore: Pick<UserStore, 'findById'>,
    private readonly membershipStore: MembershipReader,
  ) {}

  async resolveHuman(userId: string): Promise<HumanSubjectContext> {
    const user = this.userStore.findById(userId);
    if (!user?.tenantId) throw new SubjectResolutionError('SUBJECT_NOT_FOUND');

    if (user.tenantId === PLATFORM_TENANT_ID) {
      const platformAdmin = await this.membershipStore.getPlatformAdmin(userId);
      if (!platformAdmin) throw new SubjectResolutionError('SUBJECT_IDENTITY_MISSING');
      return this.fromPlatformAdmin(user, platformAdmin);
    }

    const membership = await this.membershipStore.getMembership(user.tenantId, userId);
    if (!membership) throw new SubjectResolutionError('SUBJECT_IDENTITY_MISSING');
    return {
      subjectType: 'human',
      subjectId: user.id,
      tenantId: user.tenantId,
      persona: membership.persona,
      isOwner: membership.isOwner,
      accountStatus: membership.status === 'active' ? accountStatus(user) : 'disabled',
      membershipVersion: membership.version,
    };
  }

  resolveService(input: Omit<ServiceSubjectContext, 'subjectType'>): ServiceSubjectContext {
    if (!input.serviceId || !input.purpose.trim()) {
      throw new SubjectResolutionError('SUBJECT_IDENTITY_MISSING');
    }
    return { subjectType: 'service', ...input };
  }

  private fromPlatformAdmin(user: UserRecord, admin: PlatformAdmin): HumanSubjectContext {
    return {
      subjectType: 'human',
      subjectId: user.id,
      tenantId: PLATFORM_TENANT_ID,
      persona: 'platform_admin',
      isOwner: false,
      accountStatus: admin.status === 'active' ? accountStatus(user) : 'disabled',
      membershipVersion: admin.version,
    };
  }
}
