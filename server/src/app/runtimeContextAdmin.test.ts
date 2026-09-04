import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../types/index.js';
import type { AppRuntime } from './runtimeContracts.js';
import { createContextProductService } from './runtimeContextAdmin.js';

describe('createContextProductService access authority', () => {
  it('uses platform target access without a synthetic target Membership and still rejects personal writes', async () => {
    const query = vi.fn();
    const listEffectiveResourceIds = vi.fn(async () => [{
      resourceId: 'collection-from-everyone', assignmentVersion: 1,
    }]);
    const listResourceSets = vi.fn(async () => [{
      resourceId: 'collection-organization', version: 3, status: 'enabled',
    }]);
    const getMembership = vi.fn(async () => null);
    const getPolicies = vi.fn(async () => [{
      policyKey: 'knowledge.org.enabled', value: true,
    }]);
    const service = createContextProductService({
      runtimePgEventStore: { pool: { query } },
      assignmentStore: { listEffectiveResourceIds, listResourceSets },
      contextSourceAuthorizationRegistry: {},
      derivedContextStore: {},
      membershipStore: { getMembership },
      entitlementStore: { getPolicies },
    } as unknown as AppRuntime, {
      auth: { jwtSecret: 'test-secret-with-sufficient-entropy' },
    } as AppConfig);
    const subject = {
      tenantId: 'tenant-b', actorId: 'platform-actor', actorTenantId: 'pantheon',
      actorPersona: 'platform_admin' as const, accessMode: 'platform_manage' as const,
    };

    expect(service).toBeDefined();
    await expect(service!.getEvidence(subject, 'opaque-evidence-handle'))
      .rejects.toThrowError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
    await expect(service!.correct(subject, 'entity-a', {
      action: 'reject', scope: 'personal', expectedRevision: 1,
      targetItemId: 'item-a', evidenceIds: ['opaque-evidence-handle'],
    })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    expect(getMembership).not.toHaveBeenCalled();
    expect(getPolicies).toHaveBeenCalledTimes(1);
    expect(listEffectiveResourceIds).not.toHaveBeenCalled();
    expect(listResourceSets).toHaveBeenCalledWith('tenant-b', 'org_knowledge');
    expect(query).not.toHaveBeenCalled();
  });
});
