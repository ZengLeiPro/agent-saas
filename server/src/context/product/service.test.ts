import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { DerivedStoreError, type DerivedEvidenceRef } from '../derived/index.js';
import {
  AssignmentContextRecallScopeResolver,
  ContextSourceAuthorizationRegistry,
  type ContextRecallScopeResolver,
} from '../retrieval/index.js';
import { ContextProductAuthorization } from './authorization.js';
import { ContextProductService } from './service.js';
import {
  ContextProductError,
  type ContextProductStore,
  ProductEntityCandidate,
  ProductEvidenceCandidate,
  ProductItemCandidate,
  ProductRecordLocator,
  ProductRelationCandidate,
  ProductTimelineCandidate,
} from './types.js';

const subject = { tenantId: 'tenant-a', actorId: 'actor-a' };
const evidenceRef: DerivedEvidenceRef = {
  sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a', recordRevision: 1, evidenceId: 'evidence-a',
};

function locator(overrides: Partial<ProductRecordLocator> = {}): ProductRecordLocator {
  return {
    sourceKind: 'taskboard', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a',
    recordRevision: 1, currentRevision: 2, recordType: 'snapshot', currentDeleted: false,
    currentRevoked: false, refused: false, metadata: { taskId: 'task-a' }, aclPrincipals: ['actor-a'], ...overrides,
  };
}
function entity(id = 'entity-a', overrides: Partial<ProductEntityCandidate> = {}): ProductEntityCandidate {
  return { entityId: id, entityType: 'Project', label: id, summary: 'safe summary', revision: 2,
    correctionRevisions: { personal: 1, organization: 1 },
    updatedAt: '2026-08-23T10:00:00.000Z', locator: locator({ recordId: `record-${id}` }), ...overrides };
}
function item(overrides: Partial<ProductItemCandidate> = {}): ProductItemCandidate {
  return { itemId: 'item-a', entityId: 'entity-a', itemType: 'Status', semanticKey: 'status', value: 'on track',
    valueFingerprint: 'a'.repeat(64), authority: 'source', state: 'confirmed', scope: { type: 'org' }, revision: 1,
    occurredAt: '2026-08-23T09:00:00.000Z', updatedAt: '2026-08-23T10:00:00.000Z', evidence: [evidenceRef], ...overrides };
}
function timeline(overrides: Partial<ProductTimelineCandidate> = {}): ProductTimelineCandidate {
  return {
    timelineId: 'item-a', type: 'Status', label: 'status', summary: 'on track',
    occurredAt: '2026-08-23T09:00:00.000Z', updatedAt: '2026-08-23T10:00:00.000Z',
    entityId: 'entity-a', entityLabel: 'entity-a', locator: locator(), evidence: [evidenceRef], ...overrides,
  };
}
function evidence(ref = evidenceRef, overrides: Partial<ProductEvidenceCandidate> = {}): ProductEvidenceCandidate {
  return { ref, locator: locator({ sourceId: ref.sourceId, collectionId: ref.collectionId, recordId: ref.recordId,
    recordRevision: ref.recordRevision }), kind: 'quote', source: 'Taskboard', author: 'Actor A',
    excerpt: 'safe quote', url: 'https://example.test/evidence', label: 'Evidence', summary: 'safe quote',
    occurredAt: '2026-08-23T09:00:00.000Z', createdAt: '2026-08-23T09:01:00.000Z', ...overrides };
}
function relation(overrides: Partial<ProductRelationCandidate['edge']> = {}): ProductRelationCandidate {
  return { locator: locator({ recordId: 'record-edge' }), edge: {
    relationId: 'edge-a', relationType: 'mentions', relationClass: 'explicit', authority: 'informational',
    reviewStatus: 'confirmed', lifecycle: 'active', validFrom: '2026-08-23T09:00:00.000Z',
    from: { entityId: 'entity-a', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a', recordRevision: 1 },
    to: { entityId: 'entity-b', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-b', recordRevision: 1 },
    evidence: evidenceRef, authorization: 'unchecked', ...overrides,
  } };
}
function store(overrides: Partial<ContextProductStore> = {}): ContextProductStore {
  const entities = [entity()];
  const items = [item()];
  return {
    listTimeline: vi.fn(async () => [timeline()]), listEntities: vi.fn(async () => entities),
    getEntity: vi.fn(async (_tenant, id) => entities.find(value => value.entityId === id) ?? null),
    listItems: vi.fn(async () => items), getItem: vi.fn(async (_tenant, entityId, itemId) =>
      items.find(value => value.entityId === entityId && value.itemId === itemId) ?? null),
    listCorrections: vi.fn(async () => []), listReviews: vi.fn(async () => []),
    getReviewGroup: vi.fn(async (_tenant, itemId) => items.filter(value => value.itemId === itemId).map(value => ({
      ...value, state: 'proposed' as const, entityLabel: value.entityId, originalSummary: null, conflict: null,
    }))),
    getCorrectionAuthorizationSnapshot: vi.fn(async () => null),
    getReviewAuthorizationSnapshot: vi.fn(async () => null),
    getEvidence: vi.fn(async (_tenant, ref) => evidence(ref)),
    getCurrentRecordLocator: vi.fn(async (_tenant, ref) => locator(ref)),
    listAdjacent: vi.fn(async () => ({ items: [], degraded: false })),
    decideReview: vi.fn(async input => ({ status: input.decision })),
    ...overrides,
  };
}
function harness(overrides: { store?: ContextProductStore; scopes?: ContextRecallScopeResolver; assigned?: string[];
  authorize?: (recordId: string) => boolean | Promise<boolean>; role?: boolean;
  appendReview?: ReturnType<typeof vi.fn>; getProfile?: ReturnType<typeof vi.fn> } = {}) {
  const registry = new ContextSourceAuthorizationRegistry({
    taskboard: { authorize: async (_subject, value) => overrides.authorize ? overrides.authorize(value.recordId) : true },
  });
  const authorization = new ContextProductAuthorization(registry, createHash('sha256').update('test').digest());
  const appendReview = overrides.appendReview ?? vi.fn(async () => ({
    reviewId: 'review-a', tenantId: 'tenant-a', entityId: 'entity-a', entityRevision: 2,
    actorId: 'actor-a', scope: { type: 'person' as const, personId: 'actor-a' }, authority: 'user' as const,
    action: 'assert' as const, itemId: 'correction-a', createdAt: '2026-08-23T11:00:00.000Z',
  }));
  const service = new ContextProductService({
    store: overrides.store ?? store(),
    scopes: overrides.scopes ?? { resolve: vi.fn(async () => ({ collections: (overrides.assigned ?? ['collection-a']).map(collectionId => ({
      collectionId, assignmentVersion: 1, resourceType: 'org_knowledge' as const,
    })), resolvedAt: '2026-08-23T11:00:00.000Z', degraded: false, degradationReasons: [] })) },
    authorization, derived: {
      appendReview: appendReview as any,
      getProfile: (overrides.getProfile ?? vi.fn(async (_tenantId, entityId, viewerId) => ({
        tenantId: 'tenant-a', entityId, viewerId, status: 'active' as const,
        facets: { role: [], tasks: [], workflow: [{ itemId: 'item-a', semanticKey: 'status', value: 'on track',
          authority: 'source' as const, evidence: [evidenceRef] }], artifacts: [], knowhow: [] },
      }))) as any,
    },
    roleGate: { mayCorrectOrganization: vi.fn(async () => overrides.role ?? true) },
    now: () => new Date('2026-08-23T11:00:00.000Z'),
  });
  return { service, authorization, appendReview };
}

describe('ContextProductService authorization boundary', () => {
  it('returns only UI-safe DTOs and opaque tenant-bound evidence handles', async () => {
    const { service, authorization } = harness();
    const page = await service.listTimeline(subject, {});
    expect(page.items).toEqual([expect.objectContaining({ id: 'item-a', summary: 'on track', evidence: [expect.objectContaining({ id: expect.stringMatching(/^ce1\./) })] })]);
    expect(JSON.stringify(page)).not.toContain('aclPrincipals');
    expect(JSON.stringify(page)).not.toContain('metadata');
    const handle = (page.items[0]!.evidence as Array<{ id: string }>)[0]!.id;
    expect(authorization.parseEvidenceHandle('tenant-a', handle)).toEqual(evidenceRef);
    expect(handle).not.toContain('source-a');
    expect(handle).not.toContain('record-a');
    expect(authorization.evidenceHandle('tenant-a', evidenceRef)).not.toBe(handle);
    expect(() => authorization.parseEvidenceHandle('tenant-b', handle)).toThrowError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
    expect(() => authorization.parseEvidenceHandle('tenant-a', `${handle}x`)).toThrowError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
    expect(() => authorization.parseEvidenceHandle('tenant-a', 'ce1.short.invalid')).toThrowError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
    expect(() => authorization.parseEvidenceHandle('tenant-a', `ce1.${'a'.repeat(2_001)}`)).toThrowError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
  });

  it.each([
    ['assignment deny', { assigned: [] as string[] }],
    ['native deny', { authorize: () => false }],
    ['native error', { authorize: () => Promise.reject(new Error('acl unavailable')) }],
  ])('fails closed for %s', async (_name, options) => {
    const page = await harness(options).service.listTimeline(subject, {});
    expect(page.items).toEqual([]);
  });

  it('denies a platform admin without tenant-b membership before everyone Assignment or organization Taskboard ACL', async () => {
    const listEffectiveResourceIds = vi.fn(async () => [{
      resourceId: 'collection-a', assignmentVersion: 1,
    }]);
    const scopes = new AssignmentContextRecallScopeResolver({ listEffectiveResourceIds }, {
      resolveAccess: async current => ({
        activeMembership: current.tenantId === 'tenant-b' && current.userId === 'platform-actor' ? false : true,
        organizationKnowledgeEnabled: true,
      }),
    });
    const nativeTaskboardAuthorization = vi.fn(async () => true);
    const productStore = store();
    const { service, authorization, appendReview } = harness({
      scopes, store: productStore, authorize: nativeTaskboardAuthorization,
    });
    const platformInTenantB = { tenantId: 'tenant-b', actorId: 'platform-actor' };
    const handle = authorization.evidenceHandle('tenant-b', evidenceRef);

    await expect(service.getEvidence(platformInTenantB, handle))
      .rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    await expect(service.correct(platformInTenantB, 'entity-a', {
      action: 'reject', scope: 'personal', expectedRevision: 1,
      targetItemId: 'item-a', evidenceIds: [handle],
    })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    expect(listEffectiveResourceIds).not.toHaveBeenCalled();
    expect(nativeTaskboardAuthorization).not.toHaveBeenCalled();
    expect(productStore.getEvidence).not.toHaveBeenCalled();
    expect(appendReview).not.toHaveBeenCalled();
  });

  it('re-evaluates knowledge.org.enabled for every Context Product call', async () => {
    let knowledgeEnabled = true;
    const listEffectiveResourceIds = vi.fn(async () => [{
      resourceId: 'collection-a', assignmentVersion: 1,
    }]);
    const scopes = new AssignmentContextRecallScopeResolver({ listEffectiveResourceIds }, {
      resolveAccess: async () => ({
        activeMembership: true,
        organizationKnowledgeEnabled: knowledgeEnabled,
      }),
    });
    const productStore = store();
    const { service, authorization } = harness({ scopes, store: productStore });
    const handle = authorization.evidenceHandle('tenant-a', evidenceRef);

    await expect(service.getEvidence(subject, handle)).resolves.toHaveLength(1);
    knowledgeEnabled = false;
    await expect(service.getEvidence(subject, handle)).rejects.toThrowError('CONTEXT_PRODUCT_NOT_FOUND');
    await expect(service.correct(subject, 'entity-a', {
      action: 'reject', scope: 'personal', expectedRevision: 1,
      targetItemId: 'item-a', evidenceIds: [handle],
    })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    expect(listEffectiveResourceIds).toHaveBeenCalledTimes(1);
    expect(productStore.getEvidence).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['deleted', { currentDeleted: true }], ['revoked', { currentRevoked: true }],
    ['refused', { refused: true }], ['historical revision ahead', { recordRevision: 3, currentRevision: 2 }],
  ])('fails closed for current record state: %s', async (_name, state) => {
    const candidate = entity('entity-a', { locator: locator(state) });
    const page = await harness({ store: store({ listEntities: vi.fn(async () => [candidate]) }) }).service.listEntities(subject, {});
    expect(page.items).toEqual([]);
  });

  it('uses current native ACL rather than historical revision ACL', async () => {
    const authorize = vi.fn(async (recordId: string) => recordId === 'record-entity-a');
    const result = await harness({ authorize }).service.listEntities(subject, {});
    expect(result.items).toHaveLength(1);
    expect(authorize).toHaveBeenCalledWith('record-entity-a');
  });

  it('drops a whole item when any evidence is unauthorized', async () => {
    const second = { ...evidenceRef, recordId: 'record-denied', evidenceId: 'evidence-denied' };
    const productStore = store({
      listTimeline: vi.fn(async () => [timeline({ evidence: [evidenceRef, second] })]),
      getEvidence: vi.fn(async (_tenant, ref) => evidence(ref)),
    });
    const result = await harness({ store: productStore, authorize: id => id !== 'record-denied' }).service.listTimeline(subject, {});
    expect(result.items).toEqual([]);
  });

  it('authorizes both exact edge endpoint records and does not expand a hidden intermediate node', async () => {
    const hidden = entity('hidden', { locator: locator({ recordId: 'record-visible-alias' }) });
    const visible = entity('visible');
    const entities = [entity(), hidden, visible];
    const adjacent = vi.fn(async (_tenant: string, ids: string[]) => ({ items: ids.includes('entity-a') ? [{
      locator: locator({ recordId: 'record-edge' }),
      edge: {
        relationId: 'edge-hidden', relationType: 'mentions' as const, relationClass: 'explicit' as const,
        authority: 'informational' as const, reviewStatus: 'confirmed' as const, lifecycle: 'active' as const,
        validFrom: '2026-08-23T09:00:00.000Z', from: { entityId: 'entity-a', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a', recordRevision: 1 },
        to: { entityId: 'hidden', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-hidden', recordRevision: 1 },
        evidence: evidenceRef, authorization: 'unchecked' as const,
      },
    }] : [], degraded: false }));
    const productStore = store({
      getEntity: vi.fn(async (_tenant, id) => entities.find(value => value.entityId === id) ?? null), listAdjacent: adjacent,
    });
    const page = await harness({ store: productStore, authorize: id => id !== 'record-hidden' }).service.listRelations(subject, 'entity-a', { depth: 2 });
    expect(page.items).toEqual([]);
    expect(adjacent).toHaveBeenCalledTimes(1);
  });

  it('reports the actual hop origin and depth for two-hop relations', async () => {
    const entities = [entity(), entity('middle'), entity('leaf')];
    const listAdjacent = vi.fn(async (_tenant: string, ids: string[]) => ({
      items: ids.includes('entity-a')
        ? [relation({ relationId: 'edge-1', to: { entityId: 'middle', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-middle', recordRevision: 1 } })]
        : [relation({ relationId: 'edge-2', from: { entityId: 'middle', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-middle', recordRevision: 1 },
          to: { entityId: 'leaf', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-leaf', recordRevision: 1 } })],
      degraded: false,
    }));
    const productStore = store({
      getEntity: vi.fn(async (_tenant, id) => entities.find(value => value.entityId === id) ?? null),
      listAdjacent,
    });

    const page = await harness({ store: productStore }).service.listRelations(subject, 'entity-a', { depth: 2 });
    expect(page.items).toEqual([
      expect.objectContaining({ id: 'edge-1', depth: 1, fromEntity: expect.objectContaining({ id: 'entity-a' }),
        targetEntity: expect.objectContaining({ id: 'middle' }) }),
      expect.objectContaining({ id: 'edge-2', depth: 2, fromEntity: expect.objectContaining({ id: 'middle' }),
        targetEntity: expect.objectContaining({ id: 'leaf' }) }),
    ]);
  });

  it('outputs parallel relation/evidence edges while expanding their shared neighbor only once', async () => {
    const entities = [entity(), entity('middle'), entity('leaf')];
    const secondEvidence = { ...evidenceRef, evidenceId: 'evidence-b' };
    const listAdjacent = vi.fn(async (_tenant: string, ids: string[]) => ({
      items: ids.includes('entity-a') ? [
        relation({ relationId: 'edge-a', relationType: 'mentions', to: { entityId: 'middle', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-middle', recordRevision: 1 } }),
        relation({ relationId: 'edge-b', relationType: 'project_of', evidence: secondEvidence, to: { entityId: 'middle', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-middle', recordRevision: 1 } }),
      ] : [relation({ relationId: 'edge-leaf', from: { entityId: 'middle', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-middle', recordRevision: 1 },
        to: { entityId: 'leaf', sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-leaf', recordRevision: 1 } })],
      degraded: false,
    }));
    const productStore = store({
      getEntity: vi.fn(async (_tenant, id) => entities.find(value => value.entityId === id) ?? null),
      getEvidence: vi.fn(async (_tenant, ref) => evidence(ref)),
      listAdjacent,
    });

    const page = await harness({ store: productStore }).service.listRelations(subject, 'entity-a', { depth: 2 });
    expect(page.items.map(value => value.id)).toEqual(['edge-a', 'edge-b', 'edge-leaf']);
    expect(listAdjacent.mock.calls[1]![1]).toEqual(['middle']);
  });

  it.each([
    ['future', { validFrom: '2026-08-23T12:00:00.000Z' }],
    ['expired', { validTo: '2026-08-23T11:00:00.000Z' }],
  ])('rejects %s relation validity windows', async (_name, validity) => {
    const endpointLookup = vi.fn(async (_tenant: string, ref: ProductRelationCandidate['edge']['from']) => locator(ref));
    const productStore = store({
      getEntity: vi.fn(async (_tenant, id) => entity(id)),
      getCurrentRecordLocator: endpointLookup,
      listAdjacent: vi.fn(async () => ({ items: [relation(validity)], degraded: false })),
    });
    const page = await harness({ store: productStore }).service.listRelations(subject, 'entity-a', {});
    expect(page.items).toEqual([]);
    expect(page.degraded).toBe(true);
    expect(endpointLookup).not.toHaveBeenCalled();
  });

  it('rejects cursor tampering and cross-tenant reuse', async () => {
    const entities = Array.from({ length: 2 }, (_, index) => entity(`entity-${index}`));
    const service = harness({ store: store({ listEntities: vi.fn(async () => entities),
      getEntity: vi.fn(async (_tenant, id) => entities.find(value => value.entityId === id) ?? null) }) }).service;
    const first = await service.listEntities(subject, { limit: 1 });
    expect(first.nextCursor).toMatch(/^cp1\./);
    await expect(service.listEntities(subject, { limit: 1, cursor: `${first.nextCursor}x` })).rejects.toThrowError('CONTEXT_PRODUCT_CURSOR_INVALID');
    await expect(service.listEntities({ tenantId: 'tenant-b', actorId: 'actor-a' }, { limit: 1, cursor: first.nextCursor! }))
      .rejects.toThrowError('CONTEXT_PRODUCT_CURSOR_INVALID');
  });

  it.each(['timeline', 'entities', 'reviews'] as const)(
    'marks %s degraded when its internal candidate ceiling is reached', async endpoint => {
      const candidates = Array.from({ length: 200 }, (_, index) => index);
      const listTimeline = vi.fn(async () => candidates.map(index => timeline({ timelineId: `timeline-${index}` })));
      const listEntities = vi.fn(async () => candidates.map(index => entity(`entity-${index}`)));
      const listReviews = vi.fn(async () => candidates.map(index => ({
        ...item({ itemId: `review-${index}`, state: 'proposed' }), entityLabel: 'entity-a',
        originalSummary: null, conflict: null,
      })));
      const service = harness({ store: store({ listTimeline, listEntities, listReviews }) }).service;
      const page = endpoint === 'timeline' ? await service.listTimeline(subject, {})
        : endpoint === 'entities' ? await service.listEntities(subject, {})
          : await service.listReviews(subject, {});
      expect(page.items).toHaveLength(25);
      expect(page.degraded).toBe(true);
      const candidateCall = endpoint === 'timeline' ? listTimeline : endpoint === 'entities' ? listEntities : listReviews;
      expect(candidateCall).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });

  it('provides signed load-more pages for entity items and marks the candidate ceiling degraded', async () => {
    const candidates = Array.from({ length: 201 }, (_, index) => item({ itemId: `item-${index}` }));
    const listItems = vi.fn(async () => candidates);
    const service = harness({ store: store({ listItems }) }).service;
    const first = await service.listEntityItems(subject, 'entity-a', { limit: 2 });
    expect(first.items.map(value => value.id)).toEqual(['item-0', 'item-1']);
    expect(first.nextCursor).toMatch(/^cp1\./);
    expect(first.degraded).toBe(true);
    const second = await service.listEntityItems(subject, 'entity-a', { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map(value => value.id)).toEqual(['item-2', 'item-3']);
    expect(listItems).toHaveBeenCalledWith('tenant-a', 'entity-a', 201);
  });

  it('exposes review/correctable state and refuses non-confirmed correction targets', async () => {
    const proposed = item({ itemId: 'item-proposed', state: 'proposed' });
    const productStore = store({
      listItems: vi.fn(async () => [item(), proposed]),
      getItem: vi.fn(async () => proposed),
    });
    const { service, authorization, appendReview } = harness({ store: productStore });
    const detail = await service.getEntity(subject, 'entity-a');
    expect(detail.items).toEqual([
      expect.objectContaining({ id: 'item-a', review: 'confirmed', correctable: true, correctionDisabledReason: null }),
      expect.objectContaining({ id: 'item-proposed', review: 'proposed', correctable: false, correctionDisabledReason: 'pending_review' }),
    ]);
    await expect(service.correct(subject, 'entity-a', { action: 'reject', scope: 'personal', expectedRevision: 1,
      targetItemId: 'item-proposed', evidenceIds: [authorization.evidenceHandle('tenant-a', evidenceRef)] }))
      .rejects.toThrowError('CONTEXT_PRODUCT_NOT_FOUND');
    expect(appendReview).not.toHaveBeenCalled();
  });

  it('re-authorizes encrypted evidence and derives correction semantics from the target item', async () => {
    const { service, authorization, appendReview } = harness();
    const handle = authorization.evidenceHandle('tenant-a', evidenceRef);
    await service.correct(subject, 'entity-a', { action: 'reject', scope: 'personal', expectedRevision: 1,
      targetItemId: 'item-a', evidenceIds: [handle] });
    expect(appendReview).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'actor-a', action: 'reject', rejectFingerprint: 'a'.repeat(64),
      scope: { type: 'person', personId: 'actor-a' }, evidence: [evidenceRef],
    }));
    expect(appendReview.mock.calls[0]![0]).not.toHaveProperty('valueFingerprint');
  });

  it('rejects an authorized evidence handle not exactly attached to the correction target', async () => {
    const unrelatedRef = { ...evidenceRef, recordId: 'record-unrelated', recordRevision: 2, evidenceId: 'evidence-unrelated' };
    const getEvidence = vi.fn(async (_tenant: string, ref: DerivedEvidenceRef) => evidence(ref));
    const productStore = store({ getEvidence });
    const { service, authorization, appendReview } = harness({ store: productStore, authorize: () => true });
    const handle = authorization.evidenceHandle('tenant-a', unrelatedRef);

    await expect(service.correct(subject, 'entity-a', { action: 'assert', scope: 'personal', expectedRevision: 1,
      targetItemId: 'item-a', summary: 'new value', evidenceIds: [handle] }))
      .rejects.toThrowError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
    expect(appendReview).not.toHaveBeenCalled();
    expect(getEvidence).not.toHaveBeenCalledWith('tenant-a', unrelatedRef);
  });

  it('never exposes another viewer personal items in entity detail, correction targets or reviews', async () => {
    const hiddenRef = { ...evidenceRef, recordId: 'record-hidden-personal', evidenceId: 'hidden-personal' };
    const own = item({ itemId: 'own', scope: { type: 'person', personId: 'actor-a' } });
    const hidden = item({ itemId: 'hidden', scope: { type: 'person', personId: 'actor-b' }, evidence: [hiddenRef] });
    const getEvidence = vi.fn(async (_tenant: string, ref: DerivedEvidenceRef) => evidence(ref));
    const proposed = (value: ProductItemCandidate) => ({ ...value, state: 'proposed' as const,
      entityLabel: 'entity-a', originalSummary: null, conflict: null });
    const productStore = store({ listItems: vi.fn(async () => [item(), own, hidden]),
      getItem: vi.fn(async (_tenant, _entity, id) => id === 'hidden' ? hidden : own),
      listReviews: vi.fn(async () => [proposed(hidden), proposed(own)]), getEvidence });
    const { service, authorization, appendReview } = harness({ store: productStore });

    const detail = await service.getEntity(subject, 'entity-a');
    expect(detail.correctionRevisions).toEqual({ personal: 1, organization: 1 });
    expect((detail.items as Array<{ id: string }>).map(value => value.id)).toEqual(['item-a', 'own']);
    expect(JSON.stringify(detail)).not.toContain('hidden-personal');
    expect(getEvidence).not.toHaveBeenCalledWith('tenant-a', hiddenRef);

    const reviews = await service.listReviews(subject, {});
    expect(reviews.items.map(value => value.id)).toEqual(['own']);
    await expect(service.correct(subject, 'entity-a', { action: 'reject', scope: 'personal', expectedRevision: 1,
      targetItemId: 'hidden', evidenceIds: [authorization.evidenceHandle('tenant-a', evidenceRef)] }))
      .rejects.toThrowError('CONTEXT_PRODUCT_NOT_FOUND');
    expect(appendReview).not.toHaveBeenCalled();
  });

  it('builds profiles only from fixed reduced facets and re-authorizes each facet evidence', async () => {
    const deniedRef = { ...evidenceRef, recordId: 'record-denied', evidenceId: 'denied' };
    const getProfile = vi.fn(async () => ({ tenantId: 'tenant-a', entityId: 'entity-a', viewerId: 'actor-a',
      status: 'active' as const, facets: {
        role: [{ itemId: 'role', semanticKey: 'role', value: 'owner', authority: 'source' as const, evidence: [evidenceRef] }],
        tasks: [{ itemId: 'task', semanticKey: 'task:a', value: 'ship', authority: 'user' as const, evidence: [evidenceRef] }],
        workflow: [], artifacts: [],
        knowhow: [{ itemId: 'secret', semanticKey: 'knowhow:a', value: 'secret', authority: 'source' as const, evidence: [deniedRef] }],
      },
    }));
    const productStore = store({ listItems: vi.fn(async () => [item({ itemId: 'rogue', semanticKey: 'rogue' })]),
      getEvidence: vi.fn(async (_tenant, ref) => evidence(ref)) });
    const profile = await harness({ store: productStore, getProfile, authorize: id => id !== 'record-denied' })
      .service.getProfile(subject, 'entity-a');
    expect(getProfile).toHaveBeenCalledWith('tenant-a', 'entity-a', 'actor-a');
    expect((profile.attributes as Array<{ id: string; type: string }>)).toEqual([
      expect.objectContaining({ id: 'role', type: 'role' }), expect.objectContaining({ id: 'task', type: 'tasks' }),
    ]);
    expect(JSON.stringify(profile)).not.toContain('rogue');
    expect(JSON.stringify(profile)).not.toContain('secret');
    expect(profile.degraded).toBe(true);
  });

  it('returns both review decision states while GET remains proposed/conflicted only', async () => {
    const proposed = { ...item({ state: 'proposed' }), entityLabel: 'entity-a', originalSummary: null, conflict: null };
    const productStore = store({ listReviews: vi.fn(async () => [proposed]),
      decideReview: vi.fn(async input => ({ status: input.decision })) });
    const service = harness({ store: productStore }).service;
    const confirmed = await service.decideReview(subject, 'item-a', { decision: 'confirmed', expectedRevision: 1 });
    expect(confirmed).toEqual({ status: 'confirmed' });
    const rejected = await service.decideReview(subject, 'item-a', { decision: 'rejected', expectedRevision: 1 });
    expect(rejected).toEqual({ status: 'rejected' });
    const confirmedStore = store({ listReviews: vi.fn(async () => [{ ...proposed, state: 'confirmed' as const }]) });
    await expect(harness({ store: confirmedStore }).service.listReviews(subject, {}))
      .resolves.toMatchObject({ items: [] });
  });

  it.each(['proposed', 'conflicted'] as const)('returns only %s reviews for the reserved state filter', async state => {
    const proposed = { ...item({ itemId: 'proposed', state: 'proposed' }),
      entityLabel: 'entity-a', originalSummary: null, conflict: null };
    const conflicted = { ...item({ itemId: 'conflicted', state: 'conflicted' }),
      entityLabel: 'entity-a', originalSummary: null, conflict: 'open' };
    const listReviews = vi.fn(async () => [proposed, conflicted]);
    const page = await harness({ store: store({ listReviews }) }).service.listReviews(subject, { filter: state });
    expect(page.items.map(value => value.id)).toEqual([state]);
    expect(listReviews).toHaveBeenCalledWith(expect.objectContaining({ filter: state }));
  });

  it('returns evidence fields only from data_json and computes freshness from the exact revision', async () => {
    const exact = evidence(evidenceRef, { locator: locator({ currentRevision: 1 }) });
    const productStore = store({ getEvidence: vi.fn(async () => exact) });
    const { service, authorization } = harness({ store: productStore });
    const handle = authorization.evidenceHandle('tenant-a', evidenceRef);
    await expect(service.getEvidence(subject, handle)).resolves.toEqual([{
      id: handle, sourceName: 'Taskboard', collection: 'collection-a', author: 'Actor A',
      occurredAt: '2026-08-23T09:00:00.000Z', quote: 'safe quote', derived: false,
      freshness: 'fresh', freshnessAsOf: '2026-08-23T09:00:00.000Z',
      originalUrl: 'https://example.test/evidence',
    }]);
  });

  it('fails a correction closed when ACL changes after precheck but before locked-snapshot authorization', async () => {
    let aclLive = true;
    const snapshot = {
      tenantId: 'tenant-a', entityId: 'entity-a', generation: '7', itemId: 'item-a', itemType: 'Status' as const,
      semanticKey: 'status', valueFingerprint: 'a'.repeat(64), ownerPrincipal: null,
      evidence: [evidenceRef], scope: { type: 'person' as const, personId: 'actor-a' },
    };
    const productStore = store({ getCorrectionAuthorizationSnapshot: vi.fn(async () => snapshot) });
    const appendReview = vi.fn(async (input: any) => {
      aclLive = false;
      if (!await input.authorize(snapshot)) throw new DerivedStoreError('DERIVED_FORBIDDEN');
      throw new Error('unexpected authorization');
    });
    const { service, authorization } = harness({ store: productStore, appendReview, authorize: () => aclLive });
    await expect(service.correct(subject, 'entity-a', {
      action: 'reject', scope: 'personal', expectedRevision: 1, targetItemId: 'item-a',
      evidenceIds: [authorization.evidenceHandle('tenant-a', evidenceRef)],
    })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    expect(productStore.getCorrectionAuthorizationSnapshot).toHaveBeenCalledWith(expect.objectContaining({ generation: '7', itemId: 'item-a' }));
  });

  it('fails a correction closed when the independently re-read exact item snapshot drifts', async () => {
    const locked = {
      tenantId: 'tenant-a', entityId: 'entity-a', generation: '7', itemId: 'item-a', itemType: 'Status' as const,
      semanticKey: 'status', valueFingerprint: 'a'.repeat(64), ownerPrincipal: null,
      evidence: [evidenceRef], scope: { type: 'person' as const, personId: 'actor-a' },
    };
    const productStore = store({ getCorrectionAuthorizationSnapshot: vi.fn(async () => ({
      ...locked, valueFingerprint: 'b'.repeat(64),
    })) });
    const appendReview = vi.fn(async (input: any) => {
      if (!await input.authorize(locked)) throw new DerivedStoreError('DERIVED_FORBIDDEN');
      throw new Error('unexpected authorization');
    });
    const { service, authorization } = harness({ store: productStore, appendReview });
    await expect(service.correct(subject, 'entity-a', {
      action: 'reject', scope: 'personal', expectedRevision: 1, targetItemId: 'item-a',
      evidenceIds: [authorization.evidenceHandle('tenant-a', evidenceRef)],
    })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
  });

  it('fails a review decision closed when the complete independently read group fingerprint drifts', async () => {
    const target = { ...item({ state: 'proposed' }), entityLabel: 'Entity A', originalSummary: null, conflict: null };
    const locked = {
      tenantId: 'tenant-a', targetItemId: 'item-a', entityId: 'entity-a', itemType: 'Status' as const,
      semanticKey: 'status', count: 1, fingerprint: 'a'.repeat(64), items: [{
        generation: '7', itemId: 'item-a', revision: 1, status: 'proposed', conflict: 'none',
        valueFingerprint: 'a'.repeat(64), evidence: [evidenceRef],
      }],
    };
    const decideReview = vi.fn(async (input: any) => {
      if (!await input.authorize(locked)) throw new ContextProductError('CONTEXT_PRODUCT_FORBIDDEN');
      return { status: input.decision };
    });
    const productStore = store({
      getReviewGroup: vi.fn(async () => [target]),
      getReviewAuthorizationSnapshot: vi.fn(async () => ({ ...locked, fingerprint: 'b'.repeat(64) })),
      decideReview,
    });
    await expect(harness({ store: productStore }).service.decideReview(subject, 'item-a', {
      decision: 'confirmed', expectedRevision: 1,
    })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    expect(productStore.getReviewAuthorizationSnapshot).toHaveBeenCalledWith('tenant-a', 'item-a', 201);
  });

  it('rejects an organization correction targeting a personal item before appendReview', async () => {
    const personal = item({ scope: { type: 'person', personId: 'actor-a' } });
    const productStore = store({ getItem: vi.fn(async () => personal) });
    const { service, authorization, appendReview } = harness({ store: productStore });
    await expect(service.correct(subject, 'entity-a', {
      action: 'reject', scope: 'organization', expectedRevision: 1, targetItemId: 'item-a',
      evidenceIds: [authorization.evidenceHandle('tenant-a', evidenceRef)],
    })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    expect(appendReview).not.toHaveBeenCalled();
  });

  it.each(['hidden', 'missing-evidence', 'over-limit'] as const)(
    'rejects review when the complete sibling group is %s and never enters the store transaction', async failure => {
      const target = { ...item({ state: 'proposed' }), entityLabel: 'Entity A', originalSummary: null, conflict: null };
      const sibling = { ...target, itemId: 'sibling', ...(failure === 'hidden'
        ? { scope: { type: 'person' as const, personId: 'actor-b' } }
        : failure === 'missing-evidence' ? { evidence: [] } : {}) };
      const group = failure === 'over-limit'
        ? Array.from({ length: 201 }, (_, index) => ({ ...target, itemId: index === 0 ? 'item-a' : `sibling-${index}` }))
        : [target, sibling];
      const decideReview = vi.fn(async input => ({ status: input.decision }));
      const productStore = store({ getReviewGroup: vi.fn(async () => group), decideReview });
      await expect(harness({ store: productStore }).service.decideReview(subject, 'item-a', {
        decision: 'confirmed', expectedRevision: 1,
      })).rejects.toThrow();
      expect(decideReview).not.toHaveBeenCalled();
    });

  it('rejects mismatched targets, unauthorized evidence, role gate denial and CAS conflicts', async () => {
    const { service, authorization } = harness({ role: false });
    const handle = authorization.evidenceHandle('tenant-a', evidenceRef);
    await expect(service.correct(subject, 'entity-a', { action: 'assert', scope: 'personal', expectedRevision: 1,
      targetItemId: 'missing', summary: 'new', evidenceIds: [handle] })).rejects.toThrowError('CONTEXT_PRODUCT_NOT_FOUND');
    await expect(service.correct(subject, 'entity-a', { action: 'assert', scope: 'organization', expectedRevision: 1,
      targetItemId: 'item-a', summary: 'new', evidenceIds: [handle] })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');

    const denied = harness({ authorize: id => id !== 'record-a' });
    await expect(denied.service.correct(subject, 'entity-a', { action: 'assert', scope: 'personal', expectedRevision: 1,
      targetItemId: 'item-a', summary: 'new', evidenceIds: [denied.authorization.evidenceHandle('tenant-a', evidenceRef)] }))
      .rejects.toThrow();

    const proposed = item({ state: 'proposed' });
    const reviewStore = store({ listReviews: vi.fn(async () => [{ ...proposed, entityLabel: 'entity-a', originalSummary: null, conflict: null }]) });
    await expect(harness({ store: reviewStore, role: false }).service.decideReview(subject, 'item-a', { decision: 'confirmed', expectedRevision: 1 }))
      .rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');

    const conflict = harness({ appendReview: vi.fn(async () => { throw new DerivedStoreError('DERIVED_VERSION_CONFLICT'); }) });
    await expect(conflict.service.correct(subject, 'entity-a', { action: 'assert', scope: 'personal', expectedRevision: 1,
      targetItemId: 'item-a', summary: 'new', evidenceIds: [conflict.authorization.evidenceHandle('tenant-a', evidenceRef)] }))
      .rejects.toThrowError('CONTEXT_PRODUCT_CONFLICT');
  });
});
