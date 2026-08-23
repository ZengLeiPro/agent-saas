import { describe, expect, it } from 'vitest';

import { normalizeDirectoryPerson } from './normalizer.js';

const observedAt = '2026-08-23T00:00:00.000Z';

describe('directory context normalizer', () => {
  it('projects only minimal person fields and stable native identity', () => {
    const record = normalizeDirectoryPerson({
      tenantId: 'tenant-a',
      userId: 'user-1',
      username: 'zenglei',
      displayName: '曾磊',
      position: 'CEO',
      role: 'admin',
      status: 'active',
      updatedAt: observedAt,
      // Runtime adapters may carry richer rows; the normalizer must ignore them.
      phone: '13800000000',
      passwordHash: 'secret',
    } as never, observedAt);

    expect(record).toMatchObject({
      externalRecordId: 'user-1',
      entityType: 'person',
      nativeId: 'user-1',
      revoked: false,
      aclPrincipals: ['org:tenant-a'],
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('13800000000');
    expect(serialized).not.toContain('secret');
  });

  it('revokes disabled members rather than deleting their evidence', () => {
    const record = normalizeDirectoryPerson({
      tenantId: 'tenant-a', userId: 'user-2', username: 'disabled', status: 'disabled', updatedAt: observedAt,
    }, observedAt);
    expect(record.revoked).toBe(true);
    expect(record.deleted).not.toBe(true);
  });
});
