import { describe, expect, it, vi } from 'vitest';

import { ContextProductAuthorization } from './authorization.js';
import type { ProductRecordLocator } from './types.js';

const locator = (overrides: Partial<ProductRecordLocator> = {}): ProductRecordLocator => ({
  sourceKind: 'taskboard',
  sourceId: 'taskboard',
  collectionId: 'tasks',
  recordId: 'task-1',
  recordRevision: 1,
  currentRevision: 1,
  recordType: 'snapshot',
  currentDeleted: false,
  currentRevoked: false,
  refused: false,
  metadata: {},
  ...overrides,
});

describe('ContextProductAuthorization platform organization boundary', () => {
  it('allows organization ACL records but denies another member personal records', async () => {
    const authorizeBatch = vi.fn().mockResolvedValue([{ authorized: true }]);
    const authorization = new ContextProductAuthorization(
      { authorizeBatch } as never,
      'context-product-authorization-test-key-with-entropy',
    );
    const subject = {
      tenantId: 'tenant-a',
      actorId: 'platform-1',
      actorTenantId: 'pantheon',
      actorPersona: 'platform_admin' as const,
      accessMode: 'platform_manage' as const,
    };
    const scope = {
      collections: [
        { collectionId: 'tasks', resourceType: 'org_knowledge' as const, assignmentVersion: 1 },
      ],
      resolvedAt: '2026-09-04T00:00:00.000Z',
    };

    await expect(
      authorization.authorizeRecords(subject, scope, [
        locator({ ownerPrincipal: 'user:member-1', aclPrincipals: ['org:tenant-a'] }),
        locator({
          recordId: 'private-1',
          ownerPrincipal: 'user:member-1',
          aclPrincipals: ['user:member-1'],
        }),
      ]),
    ).resolves.toEqual([true, false]);
    expect(authorizeBatch).not.toHaveBeenCalled();
  });
});
