import { describe, expect, it } from 'vitest';

import { BoundedRelationWalkService, RelationWalkError } from './boundedWalk.js';
import type { RelationEdgeCandidate, RelationReadStore } from './types.js';

const key = '0123456789abcdef0123456789abcdef';

function edge(relationId: string, from: string, to: string): RelationEdgeCandidate {
  const node = (entityId: string) => ({
    entityId, sourceId: 'source', collectionId: 'collection', recordId: `record-${entityId}`, recordRevision: 1,
  });
  return {
    relationId, relationType: 'mentions', relationClass: 'explicit', authority: 'informational',
    reviewStatus: 'confirmed', lifecycle: 'active', validFrom: '2026-08-23T00:00:00.000Z',
    from: node(from), to: node(to),
    evidence: { sourceId: 'source', collectionId: 'collection', recordId: `record-${from}`, recordRevision: 1, evidenceId: `ev-${relationId}` },
    authorization: 'unchecked',
  };
}

function graphStore(edges: RelationEdgeCandidate[]): RelationReadStore {
  return {
    listAdjacent: async ({ entityIds, limit }) => edges
      .filter(value => entityIds.includes(value.from.entityId) || entityIds.includes(value.to.entityId))
      .sort((a, b) => a.relationId.localeCompare(b.relationId)).slice(0, limit),
  };
}

describe('BoundedRelationWalkService', () => {
  it('enforces one/two-hop depth and prevents cycles', async () => {
    const service = new BoundedRelationWalkService(graphStore([
      edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a'), edge('cd', 'c', 'd'),
    ]), key);

    const oneHop = await service.walk({ tenantId: 'tenant', startEntityId: 'a', maxDepth: 1 });
    expect(oneHop.candidates.map(value => value.nextEntityId)).toEqual(['b', 'c']);
    expect(oneHop.candidates.every(value => value.depth === 1)).toBe(true);
    expect(oneHop.authorization).toBe('unchecked');

    const twoHop = await service.walk({ tenantId: 'tenant', startEntityId: 'a', maxDepth: 2 });
    expect(twoHop.candidates.map(value => [value.depth, value.nextEntityId])).toEqual([[1, 'b'], [1, 'c'], [2, 'd']]);
    expect(new Set(twoHop.candidates.map(value => value.nextEntityId)).size).toBe(twoHop.candidates.length);
  });

  it('paginates deterministically with a signed request-bound cursor', async () => {
    const service = new BoundedRelationWalkService(graphStore([
      edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('ad', 'a', 'd'),
    ]), key);
    const first = await service.walk({ tenantId: 'tenant', startEntityId: 'a', maxDepth: 1, pageSize: 2 });
    expect(first.candidates.map(value => value.nextEntityId)).toEqual(['b', 'c']);
    expect(first.nextCursor).toBeTruthy();
    const second = await service.walk({ tenantId: 'tenant', startEntityId: 'a', maxDepth: 1, pageSize: 2, cursor: first.nextCursor });
    expect(second.candidates.map(value => value.nextEntityId)).toEqual(['d']);
    expect(second.nextCursor).toBeUndefined();

    await expect(service.walk({
      tenantId: 'tenant', startEntityId: 'a', maxDepth: 2, pageSize: 2, cursor: first.nextCursor,
    })).rejects.toMatchObject({ code: 'RELATION_CURSOR_INVALID' } satisfies Partial<RelationWalkError>);
    await expect(service.walk({
      tenantId: 'tenant', startEntityId: 'a', maxDepth: 1, pageSize: 2, cursor: `${first.nextCursor}x`,
    })).rejects.toMatchObject({ code: 'RELATION_CURSOR_INVALID' } satisfies Partial<RelationWalkError>);
  });

  it('caps candidates and reports truncation', async () => {
    const service = new BoundedRelationWalkService(graphStore([
      edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('ad', 'a', 'd'),
    ]), key);
    const result = await service.walk({ tenantId: 'tenant', startEntityId: 'a', maxDepth: 1, candidateLimit: 2 });
    expect(result.candidates).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
