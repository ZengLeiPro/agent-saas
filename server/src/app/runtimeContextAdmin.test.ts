import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../types/index.js';
import type { AppRuntime } from './runtimeContracts.js';
import { createContextProductService } from './runtimeContextAdmin.js';

describe('createContextProductService access authority', () => {
  it('denies cross-tenant platform content calls without an active target-tenant membership', async () => {
    const query = vi.fn();
    const listEffectiveResourceIds = vi.fn(async () => [{
      resourceId: 'collection-from-everyone', assignmentVersion: 1,
    }]);
    const getMembership = vi.fn(async () => null);
    const getPolicies = vi.fn(async () => [{
      policyKey: 'knowledge.org.enabled', value: true,
    }]);
    const service = createContextProductService({
      runtimePgEventStore: { pool: { query } },
      assignmentStore: { listEffectiveResourceIds },
      contextSourceAuthorizationRegistry: {},
      derivedContextStore: {},
      membershipStore: { getMembership },
      entitlementStore: { getPolicies },
    } as unknown as AppRuntime, {
      auth: { jwtSecret: 'test-secret-with-sufficient-entropy' },
    } as AppConfig);
    const subject = { tenantId: 'tenant-b', actorId: 'platform-actor' };

    expect(service).toBeDefined();
    await expect(service!.getEvidence(subject, 'opaque-evidence-handle'))
      .rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    await expect(service!.correct(subject, 'entity-a', {
      action: 'reject', scope: 'personal', expectedRevision: 1,
      targetItemId: 'item-a', evidenceIds: ['opaque-evidence-handle'],
    })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    expect(getMembership).toHaveBeenCalledTimes(2);
    expect(getMembership).toHaveBeenCalledWith('tenant-b', 'platform-actor');
    expect(getPolicies).toHaveBeenCalledTimes(2);
    expect(listEffectiveResourceIds).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
