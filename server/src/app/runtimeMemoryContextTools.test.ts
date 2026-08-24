import { describe, expect, it, vi } from 'vitest';

import type { ContextPgPool, ContextStore } from '../context/store/index.js';
import type { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import { createContextRecallRuntime, createRuntimeMemoryContextTools } from './runtimeMemoryContextTools.js';

const sessionCatalog = { get: vi.fn() } as unknown as SessionCatalog;

describe('createRuntimeMemoryContextTools', () => {
  it('returns no optional runtime config without available stores', () => {
    expect(createRuntimeMemoryContextTools({ sessionCatalog })).toEqual({});
  });

  it('assembles Context tools and maps effective assignments for org Agent snapshots', async () => {
    const listEffectiveResourceIds = vi.fn().mockResolvedValue([
      { resourceId: 'collection-a', assignmentVersion: 7 },
    ]);
    const result = createRuntimeMemoryContextTools({
      contextStore: {} as ContextStore,
      assignments: { listEffectiveResourceIds },
      memberships: { getMembership: vi.fn(async () => ({ status: 'active' })) },
      entitlements: { getPolicies: vi.fn(async () => [{ policyKey: 'knowledge.org.enabled', value: true }]) },
      pool: { query: vi.fn() } as unknown as ContextPgPool,
      sessionCatalog,
      tablePrefix: 'agent_runtime',
    });

    expect(result.memoryControlProviders?.flatMap(provider => provider.list().map(tool => tool.id)))
      .toEqual(['ContextSearch', 'ContextGet']);
    await expect(result.resolveOrgAgentCollectionAssignments?.({
      tenantId: 'tenant-a',
      userId: 'user-a',
      agentId: 'agent-a',
    })).resolves.toEqual([{
      collectionId: 'collection-a',
      assignmentVersion: 7,
      resourceType: 'org_knowledge',
    }]);
    expect(listEffectiveResourceIds)
      .toHaveBeenCalledWith('tenant-a', 'user-a', 'org_knowledge', 'agent-a');
  });

  it('reads membership and knowledge policy on every scope resolution so old sessions lose access immediately', async () => {
    let knowledgeEnabled = true;
    const getMembership = vi.fn(async () => ({ status: 'active' }));
    const getPolicies = vi.fn(async () => [{
      policyKey: 'knowledge.org.enabled', value: knowledgeEnabled,
    }]);
    const listEffectiveResourceIds = vi.fn(async () => [{
      resourceId: 'collection-a', assignmentVersion: 7,
    }]);
    const getSession = vi.fn(async () => ({
      tenantId: 'tenant-a', userId: 'user-a', orgAgentId: 'agent-a',
      orgAgentSnapshot: { collectionAssignments: [{
        collectionId: 'collection-a', assignmentVersion: 7, resourceType: 'org_knowledge' as const,
      }] },
    }));
    const runtime = createContextRecallRuntime({
      contextStore: {} as ContextStore,
      assignments: { listEffectiveResourceIds },
      memberships: { getMembership }, entitlements: { getPolicies },
      pool: { query: vi.fn() } as unknown as ContextPgPool,
      sessionCatalog: { get: getSession } as unknown as SessionCatalog,
    });
    const trustedSubject = {
      tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', orgAgentId: 'agent-a',
    };

    expect(runtime).toBeDefined();
    await expect(runtime!.scopes.resolve(trustedSubject, { operation: 'search' }))
      .resolves.toMatchObject({ collections: [{ collectionId: 'collection-a' }] });
    knowledgeEnabled = false;
    await expect(runtime!.scopes.resolve(trustedSubject, { operation: 'get', recallId: 'old-hit' }))
      .resolves.toMatchObject({ collections: [] });
    expect(getMembership).toHaveBeenCalledTimes(2);
    expect(getPolicies).toHaveBeenCalledTimes(2);
    expect(listEffectiveResourceIds).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing MemoryCommand provider assembly', () => {
    const result = createRuntimeMemoryContextTools({
      sessionCatalog,
      memoryStore: {} as PgMemoryConsolidationStore,
    });

    expect(result.memoryControlProviders?.flatMap(provider => provider.list().map(tool => tool.id)))
      .toEqual(['MemoryCommand']);
  });
});
