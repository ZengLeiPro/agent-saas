import { describe, expect, it, vi } from 'vitest';

import type { ContextPgPool, ContextStore } from '../context/store/index.js';
import type { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import { createRuntimeMemoryContextTools } from './runtimeMemoryContextTools.js';

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

  it('preserves the existing MemoryCommand provider assembly', () => {
    const result = createRuntimeMemoryContextTools({
      sessionCatalog,
      memoryStore: {} as PgMemoryConsolidationStore,
    });

    expect(result.memoryControlProviders?.flatMap(provider => provider.list().map(tool => tool.id)))
      .toEqual(['MemoryCommand']);
  });
});
