import type {
  ContextSourceAuthorizationSubject,
  ContextSourceAuthorizer,
  ContextSourceLocator,
} from './sourceAuthorization.js';

export interface ContextNativePrincipalSet {
  principals: readonly string[];
  privileged?: boolean;
}

export interface ContextNativePrincipalResolver {
  resolve(
    subject: ContextSourceAuthorizationSubject,
    sourceKind: string,
  ): Promise<ContextNativePrincipalSet | null>;
}

/** Authorizes persisted owner/ACL principals; missing identity or empty ACL fails closed. */
export class PrincipalContextSourceAuthorizer implements ContextSourceAuthorizer {
  constructor(private readonly resolver: ContextNativePrincipalResolver) {}

  async authorizeBatch(
    subject: ContextSourceAuthorizationSubject,
    locators: readonly ContextSourceLocator[],
  ): Promise<readonly boolean[]> {
    const byKind = new Map<string, ContextNativePrincipalSet | null>();
    const results: boolean[] = [];
    for (const locator of locators) {
      let resolved = byKind.get(locator.sourceKind);
      if (resolved === undefined) {
        resolved = await this.resolver.resolve(subject, locator.sourceKind);
        byKind.set(locator.sourceKind, resolved);
      }
      if (!resolved) {
        results.push(false);
        continue;
      }
      if (resolved.privileged === true) {
        results.push(true);
        continue;
      }
      const allowed = new Set(resolved.principals);
      results.push(
        Boolean(locator.ownerPrincipal && allowed.has(locator.ownerPrincipal))
        || (locator.aclPrincipals ?? []).some(principal => allowed.has(principal)),
      );
    }
    return results;
  }
}

export interface DirectoryMembershipAuthorizationPort {
  isActive(tenantId: string, userId: string): Promise<boolean>;
}

/** Directory content is deliberately organization-minimal; Assignment and active membership are its ACL. */
export class DirectoryContextSourceAuthorizer implements ContextSourceAuthorizer {
  constructor(private readonly memberships: DirectoryMembershipAuthorizationPort) {}

  async authorizeBatch(
    subject: ContextSourceAuthorizationSubject,
    locators: readonly ContextSourceLocator[],
  ): Promise<readonly boolean[]> {
    const active = await this.memberships.isActive(subject.tenantId, subject.userId);
    return locators.map(locator => active && locator.sourceKind === 'directory');
  }
}
