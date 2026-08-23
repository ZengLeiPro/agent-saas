import { describe, expect, it } from 'vitest';

import {
  ContextSourceAuthorizationRegistry,
  type ContextSourceLocator,
} from './sourceAuthorization.js';

const locator: ContextSourceLocator = {
  sourceKind: 'taskboard', sourceId: 'source', collectionId: 'collection', recordId: 'record', revision: 1,
  recordType: 'snapshot', resourceType: 'board', boardId: 'board', deleted: false, metadata: {},
};
const subject = { tenantId: 'tenant-a', userId: 'user-a' };

describe('ContextSourceAuthorizationRegistry', () => {
  it('batches registered source checks', async () => {
    const registry = new ContextSourceAuthorizationRegistry({
      taskboard: { authorizeBatch: async (_subject, values) => values.map(value => value.recordId === 'record') },
    });
    await expect(registry.authorizeBatch(subject, [locator, { ...locator, recordId: 'other' }])).resolves.toEqual([
      { authorized: true }, { authorized: false },
    ]);
  });

  it('fails closed for unknown sources and authorizer errors', async () => {
    const registry = new ContextSourceAuthorizationRegistry({
      broken: { authorizeBatch: async () => { throw new Error('db unavailable'); } },
    });
    await expect(registry.authorize(subject, locator)).resolves.toEqual({
      authorized: false, reason: 'context_source_authorizer_missing',
    });
    await expect(registry.authorize(subject, { ...locator, sourceKind: 'broken' })).resolves.toEqual({
      authorized: false, reason: 'context_source_authorization_error',
    });
  });
});
