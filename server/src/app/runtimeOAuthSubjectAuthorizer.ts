import type { PgGovernanceChangeJobStore } from '../data/changeJobs/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { UserStore } from '../data/users/store.js';
import { SubjectResolver } from '../governance/subject/resolver.js';

export function createRuntimeOAuthSubjectAuthorizer(deps: {
  userStore?: UserStore;
  tenantStore?: TenantStore;
  membershipStore?: PgMembershipStore;
  governanceChangeJobStore?: PgGovernanceChangeJobStore;
}): (userId: string, tenantId: string) => Promise<boolean> {
  return async (userId, tenantId) => {
    const user = deps.userStore?.findById(userId);
    if (
      !user ||
      user.disabled ||
      user.tenantId !== tenantId ||
      deps.tenantStore?.findById(tenantId)?.disabled
    )
      return false;
    if (!deps.userStore || !deps.membershipStore || !deps.governanceChangeJobStore) return false;
    const subject = await new SubjectResolver(deps.userStore, deps.membershipStore)
      .resolveHuman(userId)
      .catch(() => null);
    if (!subject || subject.tenantId !== tenantId || subject.accountStatus !== 'active')
      return false;
    return !(await deps.governanceChangeJobStore.findActiveForTarget(
      tenantId,
      'user_offboarding',
      'user',
      userId,
    ));
  };
}
