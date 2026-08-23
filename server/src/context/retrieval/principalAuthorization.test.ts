import { describe, expect, it } from 'vitest';

import { AzerothContextPrincipalResolver } from './azerothAuthorization.js';
import {
  DirectoryContextSourceAuthorizer,
  PrincipalContextSourceAuthorizer,
} from './principalAuthorization.js';
import type { ContextSourceLocator } from './sourceAuthorization.js';

const subject = { tenantId: 'tenant-a', userId: 'user-a' };
const locator: ContextSourceLocator = {
  sourceKind: 'azeroth', sourceId: 'source', collectionId: 'customers', recordId: 'record', revision: 1,
  recordType: 'snapshot', resourceType: 'unknown', deleted: false, metadata: {},
  ownerPrincipal: 'azeroth-employee:11111111-1111-4111-8111-111111111111',
  aclPrincipals: ['azeroth-employee:22222222-2222-4222-8222-222222222222'],
};

describe('Phase 2 principal source authorization', () => {
  it('allows owner/ACL intersection and privileged bindings, otherwise denies', async () => {
    const authorizer = new PrincipalContextSourceAuthorizer({
      resolve: async () => ({ principals: ['azeroth-employee:22222222-2222-4222-8222-222222222222'] }),
    });
    await expect(authorizer.authorizeBatch(subject, [locator])).resolves.toEqual([true]);

    const denied = new PrincipalContextSourceAuthorizer({ resolve: async () => ({ principals: [] }) });
    await expect(denied.authorizeBatch(subject, [locator])).resolves.toEqual([false]);

    const privileged = new PrincipalContextSourceAuthorizer({ resolve: async () => ({ principals: [], privileged: true }) });
    await expect(privileged.authorizeBatch(subject, [{ ...locator, aclPrincipals: [] }])).resolves.toEqual([true]);
  });

  it('resolves only the authenticated same-tenant Azeroth binding', async () => {
    const users = { findById: () => ({ id: 'user-a', username: 'sales', tenantId: 'tenant-a', disabled: false }) };
    const resolver = new AzerothContextPrincipalResolver({
      users: users as never,
      listBindings: () => [{
        tenantId: 'tenant-a', username: 'sales', token: 'secret', source: 'v2',
        employeeId: '22222222-2222-4222-8222-222222222222', roles: ['SALES'],
      }],
    });
    await expect(resolver.resolve(subject, 'azeroth')).resolves.toEqual({
      principals: ['azeroth-employee:22222222-2222-4222-8222-222222222222'], privileged: false,
    });
    await expect(resolver.resolve({ tenantId: 'tenant-b', userId: 'user-a' }, 'azeroth')).resolves.toBeNull();
  });

  it('uses active membership plus Assignment for minimal directory visibility', async () => {
    const authorizer = new DirectoryContextSourceAuthorizer({ isActive: async (_tenant, user) => user === 'user-a' });
    await expect(authorizer.authorizeBatch(subject, [{ ...locator, sourceKind: 'directory' }])).resolves.toEqual([true]);
    await expect(authorizer.authorizeBatch({ ...subject, userId: 'disabled' }, [{ ...locator, sourceKind: 'directory' }])).resolves.toEqual([false]);
  });
});
