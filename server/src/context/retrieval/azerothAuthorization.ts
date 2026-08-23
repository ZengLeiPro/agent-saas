import type { UserStore } from '../../data/users/store.js';
import {
  listAzerothTokenBindings,
  type AzerothTokenBinding,
} from '../../integrations/azeroth/tokens.js';
import type {
  ContextNativePrincipalResolver,
  ContextNativePrincipalSet,
} from './principalAuthorization.js';
import type { ContextSourceAuthorizationSubject } from './sourceAuthorization.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AzerothPrincipalResolverOptions {
  users: Pick<UserStore, 'findById'>;
  listBindings?: () => AzerothTokenBinding[];
}

/** Resolves authenticated Agent-SaaS users to audited Azeroth employee principals. */
export class AzerothContextPrincipalResolver implements ContextNativePrincipalResolver {
  private readonly listBindings: () => AzerothTokenBinding[];

  constructor(private readonly options: AzerothPrincipalResolverOptions) {
    this.listBindings = options.listBindings ?? listAzerothTokenBindings;
  }

  async resolve(
    subject: ContextSourceAuthorizationSubject,
    sourceKind: string,
  ): Promise<ContextNativePrincipalSet | null> {
    if (sourceKind !== 'azeroth') return null;
    const user = this.options.users.findById(subject.userId);
    if (!user || user.tenantId !== subject.tenantId || user.disabled) return null;
    const matches = this.listBindings().filter(binding =>
      binding.tenantId === subject.tenantId && binding.username === user.username,
    );
    if (matches.length !== 1) return null;
    const binding = matches[0]!;
    const privileged = binding.roles?.includes('ADMIN') === true;
    const employeeId = binding.employeeId?.trim();
    if (!privileged && (!employeeId || !UUID.test(employeeId))) return null;
    return {
      principals: employeeId && UUID.test(employeeId)
        ? [`azeroth-employee:${employeeId.toLowerCase()}`]
        : [],
      privileged,
    };
  }
}
