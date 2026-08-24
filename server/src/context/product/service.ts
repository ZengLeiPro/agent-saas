import { createHash } from 'node:crypto';

import {
  DerivedStoreError,
  type DerivedContextStore,
  type DerivedEvidenceRef,
  type DerivedProfile,
  type DerivedReviewAuthorizationSnapshot,
  type ProfileFacetEntry,
  type ReviewRoleGate,
} from '../derived/index.js';
import type { ContextRecallScopeResolver } from '../retrieval/ports.js';
import type { ContextRecallResolvedScope } from '../retrieval/types.js';
import type { RelationEdgeCandidate } from '../relations/types.js';
import { ContextProductAuthorization } from './authorization.js';
import {
  ContextProductError,
  type ContextProductStore,
  type ContextProductSubject,
  type ProductEntityCandidate,
  type ProductEvidenceCandidate,
  type ProductItemCandidate,
  type ProductPage,
  type ProductReviewAuthorizationSnapshot,
  type ProductReviewCandidate,
} from './types.js';

export interface ContextProductServiceOptions {
  store: ContextProductStore;
  scopes: ContextRecallScopeResolver;
  authorization: ContextProductAuthorization;
  derived: Pick<DerivedContextStore, 'appendReview' | 'getProfile'>;
  roleGate: ReviewRoleGate;
  now?: () => Date;
}

type ListQuery = { cursor?: string; limit?: number; filter?: string; type?: string };
type TimelineQuery = ListQuery & { entityId?: string; from?: string; through?: string };

/** Product application boundary. No raw Context Store object can cross this class. */
export class ContextProductService {
  private readonly now: () => Date;

  constructor(private readonly options: ContextProductServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async getEvidence(subject: ContextProductSubject, handle: string): Promise<Record<string, unknown>[]> {
    const scope = await this.scope(subject);
    const ref = this.options.authorization.parseEvidenceHandle(subject.tenantId, handle);
    const candidate = await this.options.store.getEvidence(subject.tenantId, ref);
    if (!candidate || !sameRef(candidate.ref, ref)
      || !await this.options.authorization.authorizeRecord(subject, scope, candidate.locator)) {
      throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    }
    if (!candidate.source || !candidate.excerpt || !candidate.occurredAt) {
      throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    }
    return [{
      id: handle, sourceName: candidate.source, collection: candidate.locator.collectionId,
      author: candidate.author, occurredAt: candidate.occurredAt, quote: candidate.excerpt,
      derived: candidate.kind === 'derived',
      freshness: candidate.ref.recordRevision === candidate.locator.currentRevision ? 'fresh' : 'stale',
      freshnessAsOf: candidate.occurredAt ?? candidate.createdAt, originalUrl: candidate.url,
    }];
  }

  async listTimeline(subject: ContextProductSubject, query: TimelineQuery): Promise<ProductPage<Record<string, unknown>>> {
    const scope = await this.scope(subject);
    const { limit, offset, fingerprint } = this.page(subject, 'timeline', query);
    const candidates = await this.options.store.listTimeline({
      tenantId: subject.tenantId, collectionIds: assigned(scope), limit: CANDIDATE_LIMIT,
      ...(query.filter ? { filter: query.filter } : {}), ...(query.type ? { type: query.type } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}), ...(query.from ? { from: query.from } : {}),
      ...(query.through ? { through: query.through } : {}),
    });
    const visible: Record<string, unknown>[] = [];
    let denied = false;
    for (const candidate of candidates) {
      if (!await this.options.authorization.authorizeRecord(subject, scope, candidate.locator)) {
        denied = true;
        continue;
      }
      const evidence = await this.visibleEvidence(subject, scope, candidate.evidence);
      if (!evidence) { denied = true; continue; }
      visible.push({
        ...common(candidate.timelineId, candidate.type, candidate.label, candidate.summary,
          candidate.locator.recordRevision, candidate.updatedAt, false),
        occurredAt: candidate.occurredAt, entityId: candidate.entityId, entityLabel: candidate.entityLabel,
        authority: authority('organization', 'source'), evidence,
      });
    }
    return this.slice(subject, fingerprint, visible, offset, limit,
      denied || candidates.length >= CANDIDATE_LIMIT);
  }

  async listEntities(subject: ContextProductSubject, query: ListQuery): Promise<ProductPage<Record<string, unknown>>> {
    const scope = await this.scope(subject);
    const { limit, offset, fingerprint } = this.page(subject, 'entities', query);
    const candidates = await this.options.store.listEntities({
      tenantId: subject.tenantId, collectionIds: assigned(scope), limit: CANDIDATE_LIMIT,
      ...(query.filter ? { filter: query.filter } : {}), ...(query.type ? { type: query.type } : {}),
    });
    const visible: Record<string, unknown>[] = [];
    let denied = false;
    for (const entity of candidates) {
      if (!await this.options.authorization.authorizeRecord(subject, scope, entity.locator)) { denied = true; continue; }
      visible.push(entityDto(entity, false));
    }
    return this.slice(subject, fingerprint, visible, offset, limit,
      denied || candidates.length >= CANDIDATE_LIMIT);
  }

  async getEntity(subject: ContextProductSubject, entityId: string): Promise<Record<string, unknown>> {
    const scope = await this.scope(subject);
    const entity = await this.visibleEntity(subject, scope, entityId);
    if (!entity) throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    const items = await this.options.store.listItems(subject.tenantId, entityId);
    const evidence: Record<string, unknown>[] = [];
    const visibleItems: Record<string, unknown>[] = [];
    let degraded = false;
    for (const item of items) {
      if (!personalVisible(item, subject.actorId)) continue;
      const visible = await this.visibleEvidence(subject, scope, item.evidence);
      if (!visible) { degraded = true; continue; }
      evidence.push(...visible);
      visibleItems.push(itemDto(item, visible));
    }
    const corrections = [];
    for (const correction of await this.options.store.listCorrections(subject.tenantId, entityId, subject.actorId)) {
      if (correction.scope.type === 'person' && correction.scope.personId !== subject.actorId) continue;
      const visible = await this.visibleEvidence(subject, scope, correction.evidence);
      if (!visible) { degraded = true; continue; }
      corrections.push({
        ...common(correction.reviewId, 'correction', correction.action, correction.summary,
          correction.revision, correction.createdAt, false),
        action: correction.action,
        authority: authority(correction.scope.type === 'person' ? 'personal' : 'organization', correction.authority),
        evidence: visible,
      });
    }
    return {
      ...entityDto(entity, degraded), correctionRevisions: entity.correctionRevisions,
      evidence: dedupeEvidence(evidence), items: visibleItems, corrections,
    };
  }

  async getProfile(subject: ContextProductSubject, entityId: string): Promise<Record<string, unknown>> {
    const scope = await this.scope(subject);
    const entity = await this.visibleEntity(subject, scope, entityId);
    if (!entity) throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    let profile: DerivedProfile;
    try {
      profile = await this.options.derived.getProfile(subject.tenantId, entityId, subject.actorId);
    } catch (error) { throw mapDerivedError(error); }
    if (profile.status !== 'active' || profile.tenantId !== subject.tenantId || profile.entityId !== entityId
      || profile.viewerId !== subject.actorId) throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    const attributes: Record<string, unknown>[] = [];
    let degraded = false;
    for (const facet of PROFILE_FACETS) {
      for (const entry of profile.facets[facet]) {
        const evidence = await this.visibleEvidence(subject, scope, entry.evidence);
        if (!evidence) { degraded = true; continue; }
        attributes.push(profileFacetDto(facet, entry, entity, evidence));
      }
    }
    return {
      entityId: entity.entityId, label: entity.label, summary: entity.summary, revision: entity.revision,
      updatedAt: entity.updatedAt, attributes, degraded,
    };
  }

  async listRelations(subject: ContextProductSubject, entityId: string, query: ListQuery & { depth?: number }): Promise<ProductPage<Record<string, unknown>>> {
    const scope = await this.scope(subject);
    const center = await this.visibleEntity(subject, scope, entityId);
    if (!center) throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    const depth = query.depth ?? 1;
    if (depth !== 1 && depth !== 2) throw new ContextProductError('CONTEXT_PRODUCT_INVALID');
    const { limit, offset, fingerprint } = this.page(subject, 'relations', { ...query, depth });
    const seen = new Set([entityId]);
    let frontier = new Map([[entityId, center]]);
    const output: Record<string, unknown>[] = [];
    let scanned = 0;
    let denied = false;
    for (let currentDepth = 1; currentDepth <= depth && frontier.size > 0 && scanned < CANDIDATE_LIMIT; currentDepth += 1) {
      const adjacent = await this.options.store.listAdjacent(subject.tenantId, [...frontier.keys()],
        Math.min(CANDIDATE_LIMIT - scanned, CANDIDATE_LIMIT));
      if (adjacent.degraded) denied = true;
      const next = new Map<string, ProductEntityCandidate>();
      for (const candidate of adjacent.items) {
        scanned += 1;
        if (scanned > CANDIDATE_LIMIT) break;
        const edge = candidate.edge;
        if (!relationActive(edge, this.now())) { denied = true; continue; }
        const step = relationStep(edge, frontier);
        if (!step || seen.has(step.neighborId)) continue;
        const [fromLocator, toLocator] = await Promise.all([
          this.options.store.getCurrentRecordLocator(subject.tenantId, edge.from),
          this.options.store.getCurrentRecordLocator(subject.tenantId, edge.to),
        ]);
        if (!fromLocator || !toLocator
          || !await this.options.authorization.authorizeRecord(subject, scope, fromLocator)
          || !await this.options.authorization.authorizeRecord(subject, scope, toLocator)) {
          denied = true;
          continue;
        }
        const from = frontier.get(step.fromId);
        const neighbor = await this.visibleEntity(subject, scope, step.neighborId);
        const evidence = await this.visibleEvidence(subject, scope, [edge.evidence]);
        if (!from || !await this.options.authorization.authorizeRecord(subject, scope, candidate.locator)
          || !neighbor || !evidence) { denied = true; continue; }
        seen.add(step.neighborId);
        next.set(step.neighborId, neighbor);
        output.push({
          ...common(edge.relationId, edge.relationType, edge.relationType, null, 1, edge.validFrom, false),
          level: edge.relationClass,
          depth: currentDepth,
          reviewStatus: edge.reviewStatus,
          fromEntity: { id: from.entityId, type: from.entityType, label: from.label, summary: from.summary },
          targetEntity: { id: neighbor.entityId, type: neighbor.entityType, label: neighbor.label, summary: neighbor.summary },
          authority: authority('organization', edge.authority), evidence,
        });
      }
      frontier = next;
    }
    return this.slice(subject, fingerprint, output, offset, limit, denied || scanned >= CANDIDATE_LIMIT);
  }

  async listReviews(subject: ContextProductSubject, query: ListQuery): Promise<ProductPage<Record<string, unknown>>> {
    const scope = await this.scope(subject);
    const { limit, offset, fingerprint } = this.page(subject, 'reviews', query);
    const stateFilter = query.filter === 'proposed' || query.filter === 'conflicted' ? query.filter : null;
    const candidates = await this.options.store.listReviews({ tenantId: subject.tenantId,
      collectionIds: assigned(scope), limit: CANDIDATE_LIMIT, ...(query.filter ? { filter: query.filter } : {}),
      ...(query.type ? { type: query.type } : {}) });
    const visible: Record<string, unknown>[] = [];
    let denied = false;
    for (const item of candidates) {
      if (stateFilter && item.state !== stateFilter) continue;
      if (!personalVisible(item, subject.actorId)) continue;
      const entity = await this.visibleEntity(subject, scope, item.entityId);
      const evidence = entity ? await this.visibleEvidence(subject, scope, item.evidence) : null;
      if (!entity || !evidence || (item.state !== 'proposed' && item.state !== 'conflicted')) { denied = true; continue; }
      visible.push(reviewDto(item, entity, evidence));
    }
    return this.slice(subject, fingerprint, visible, offset, limit,
      denied || candidates.length >= CANDIDATE_LIMIT);
  }

  async correct(subject: ContextProductSubject, entityId: string, command: {
    action: 'assert' | 'reject'; scope: 'personal' | 'organization'; expectedRevision: number;
    targetItemId: string; summary?: string; evidenceIds: string[];
  }): Promise<Record<string, unknown>> {
    const scope = await this.scope(subject);
    if (assigned(scope).length === 0) throw new ContextProductError('CONTEXT_PRODUCT_FORBIDDEN');
    const entity = await this.visibleEntity(subject, scope, entityId);
    if (!entity) throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    const target = await this.options.store.getItem(subject.tenantId, entityId, command.targetItemId);
    if (!target || !personalVisible(target, subject.actorId)
      || !await this.visibleEvidence(subject, scope, target.evidence)) {
      throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    }
    if (command.scope === 'organization' && target.scope.type !== 'org') {
      throw new ContextProductError('CONTEXT_PRODUCT_FORBIDDEN');
    }
    if (command.action === 'assert' && !command.summary?.trim()) throw new ContextProductError('CONTEXT_PRODUCT_INVALID');
    const evidence = await this.evidenceFromHandles(subject, scope, command.evidenceIds, target.evidence);
    if (command.scope === 'organization' && !await this.options.roleGate.mayCorrectOrganization({
      tenantId: subject.tenantId, actorId: subject.actorId,
    })) throw new ContextProductError('CONTEXT_PRODUCT_FORBIDDEN');
    try {
      const review = await this.options.derived.appendReview({
        tenantId: subject.tenantId, actorId: subject.actorId, entityId, expectedRevision: command.expectedRevision,
        scope: command.scope === 'personal' ? { type: 'person', personId: subject.actorId } : { type: 'org' },
        action: command.action, targetItemId: command.targetItemId,
        authorize: snapshot => this.authorizeCorrectionSnapshot(subject, snapshot),
        ...(command.action === 'assert' ? {
          itemType: target.itemType, semanticKey: target.semanticKey, value: command.summary!.trim(),
        } : { rejectFingerprint: target.valueFingerprint }),
        evidence: evidence.map(item => item.ref), observedAt: this.now().toISOString(),
      });
      return {
        ...common(review.reviewId, 'correction', command.action, command.summary?.trim() ?? summary(target.value),
          review.entityRevision, review.createdAt, false),
        action: command.action,
        authority: authority(command.scope, review.authority),
        evidence: evidence.map(item => this.evidenceDto(subject.tenantId, item)),
      };
    } catch (error) { throw mapDerivedError(error); }
  }

  async decideReview(subject: ContextProductSubject, itemId: string, command: {
    decision: 'confirmed' | 'rejected'; expectedRevision: number;
  }): Promise<Record<string, unknown>> {
    const scope = await this.scope(subject);
    if (!await this.options.roleGate.mayCorrectOrganization({ tenantId: subject.tenantId, actorId: subject.actorId })) {
      throw new ContextProductError('CONTEXT_PRODUCT_FORBIDDEN');
    }
    const candidates = await this.options.store.getReviewGroup(subject.tenantId, itemId, CANDIDATE_LIMIT + 1);
    if (candidates.length > CANDIDATE_LIMIT) throw new ContextProductError('CONTEXT_PRODUCT_CONFLICT');
    const target = candidates.find(item => item.itemId === itemId && personalVisible(item, subject.actorId));
    if (!target) throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    const entity = await this.visibleEntity(subject, scope, target.entityId);
    if (!entity) throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
    for (const candidate of candidates) {
      if (!personalVisible(candidate, subject.actorId)
        || candidate.entityId !== target.entityId
        || !await this.visibleEvidence(subject, scope, candidate.evidence)) {
        throw new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
      }
    }
    const result = await this.options.store.decideReview({
      tenantId: subject.tenantId, actorId: subject.actorId, itemId,
      expectedRevision: command.expectedRevision, decision: command.decision,
      authorize: snapshot => this.authorizeReviewDecisionSnapshot(subject, snapshot),
    });
    return { status: result.status };
  }

  private async authorizeCorrectionSnapshot(
    subject: ContextProductSubject,
    snapshot: DerivedReviewAuthorizationSnapshot,
  ): Promise<boolean> {
    if (snapshot.tenantId !== subject.tenantId
      || (snapshot.scope.type === 'person' && snapshot.scope.personId !== subject.actorId)) return false;
    const scope = await this.scope(subject);
    if (assigned(scope).length === 0) return false;
    if (snapshot.scope.type === 'org' && !await this.options.roleGate.mayCorrectOrganization({
      tenantId: subject.tenantId,
      actorId: subject.actorId,
    })) return false;
    const current = await this.options.store.getCorrectionAuthorizationSnapshot({
      tenantId: snapshot.tenantId,
      entityId: snapshot.entityId,
      generation: snapshot.generation,
      itemId: snapshot.itemId,
      scope: snapshot.scope,
    });
    if (!current || correctionAuthorizationFingerprint(current) !== correctionAuthorizationFingerprint(snapshot)) return false;
    return this.authorizeExactEvidence(subject, scope, current.evidence);
  }

  private async authorizeReviewDecisionSnapshot(
    subject: ContextProductSubject,
    snapshot: ProductReviewAuthorizationSnapshot,
  ): Promise<boolean> {
    if (snapshot.tenantId !== subject.tenantId) return false;
    const scope = await this.scope(subject);
    if (assigned(scope).length === 0 || !await this.options.roleGate.mayCorrectOrganization({
      tenantId: subject.tenantId,
      actorId: subject.actorId,
    })) return false;
    const current = await this.options.store.getReviewAuthorizationSnapshot(
      snapshot.tenantId,
      snapshot.targetItemId,
      CANDIDATE_LIMIT + 1,
    );
    if (!current || current.count > CANDIDATE_LIMIT || snapshot.count > CANDIDATE_LIMIT
      || current.count !== snapshot.count || current.fingerprint !== snapshot.fingerprint
      || current.entityId !== snapshot.entityId || current.itemType !== snapshot.itemType
      || current.semanticKey !== snapshot.semanticKey || current.targetItemId !== snapshot.targetItemId) return false;
    for (const item of current.items) {
      if (!await this.authorizeExactEvidence(subject, scope, item.evidence)) return false;
    }
    return true;
  }

  private async authorizeExactEvidence(
    subject: ContextProductSubject,
    scope: ContextRecallResolvedScope,
    refs: readonly Readonly<DerivedEvidenceRef>[],
  ): Promise<boolean> {
    if (refs.length === 0) return false;
    for (const ref of refs) {
      const candidate = await this.options.store.getEvidence(subject.tenantId, ref);
      if (!candidate || !sameRef(candidate.ref, ref)
        || !await this.options.authorization.authorizeRecord(subject, scope, candidate.locator)) return false;
    }
    return true;
  }

  private async scope(subject: ContextProductSubject): Promise<ContextRecallResolvedScope> {
    try {
      return await this.options.scopes.resolve(
        { tenantId: subject.tenantId, userId: subject.actorId },
        { operation: 'get', recallId: 'context-product' },
      );
    } catch {
      throw new ContextProductError('CONTEXT_PRODUCT_UNAVAILABLE');
    }
  }

  private async visibleEntity(subject: ContextProductSubject, scope: ContextRecallResolvedScope, entityId: string): Promise<ProductEntityCandidate | null> {
    const entity = await this.options.store.getEntity(subject.tenantId, entityId, assigned(scope), subject.actorId);
    return entity && await this.options.authorization.authorizeRecord(subject, scope, entity.locator) ? entity : null;
  }

  private async visibleEvidence(subject: ContextProductSubject, scope: ContextRecallResolvedScope,
    refs: DerivedEvidenceRef[]): Promise<Record<string, unknown>[] | null> {
    if (refs.length === 0) return null;
    const result: Record<string, unknown>[] = [];
    for (const ref of refs) {
      const candidate = await this.options.store.getEvidence(subject.tenantId, ref);
      if (!candidate || !sameRef(candidate.ref, ref)
        || !await this.options.authorization.authorizeRecord(subject, scope, candidate.locator)) return null;
      result.push(this.evidenceDto(subject.tenantId, candidate));
    }
    return result;
  }

  private async evidenceFromHandles(subject: ContextProductSubject, scope: ContextRecallResolvedScope,
    handles: string[], targetEvidence: DerivedEvidenceRef[]): Promise<ProductEvidenceCandidate[]> {
    if (handles.length < 1) throw new ContextProductError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
    const result: ProductEvidenceCandidate[] = [];
    for (const handle of handles) {
      const ref = this.options.authorization.parseEvidenceHandle(subject.tenantId, handle);
      if (!targetEvidence.some(targetRef => sameRef(targetRef, ref))) {
        throw new ContextProductError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
      }
      const candidate = await this.options.store.getEvidence(subject.tenantId, ref);
      if (!candidate || !sameRef(candidate.ref, ref)
        || !await this.options.authorization.authorizeRecord(subject, scope, candidate.locator)) {
        throw new ContextProductError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
      }
      result.push(candidate);
    }
    return result;
  }

  private evidenceDto(tenantId: string, evidence: ProductEvidenceCandidate): Record<string, unknown> {
    return {
      id: this.options.authorization.evidenceHandle(tenantId, evidence.ref), type: evidence.kind,
      label: evidence.label, summary: evidence.summary, occurredAt: evidence.occurredAt,
    };
  }

  private page(subject: ContextProductSubject, endpoint: string, query: Record<string, unknown>) {
    const limit = Number(query.limit ?? 25);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ContextProductError('CONTEXT_PRODUCT_INVALID');
    const normalized = { ...query, cursor: undefined, limit };
    const fingerprint = createHash('sha256').update(JSON.stringify([endpoint, normalized])).digest('base64url');
    const offset = typeof query.cursor === 'string'
      ? this.options.authorization.parseCursor(subject.tenantId, fingerprint, query.cursor) : 0;
    return { limit, offset, fingerprint };
  }

  private slice(subject: ContextProductSubject, fingerprint: string, values: Record<string, unknown>[],
    offset: number, limit: number, degraded: boolean): ProductPage<Record<string, unknown>> {
    if (offset > values.length) throw new ContextProductError('CONTEXT_PRODUCT_CURSOR_INVALID');
    const items = values.slice(offset, offset + limit);
    const next = offset + items.length;
    return { items, nextCursor: next < values.length
      ? this.options.authorization.cursor(subject.tenantId, fingerprint, next) : null, degraded };
  }
}

const CANDIDATE_LIMIT = 200;

const PROFILE_FACETS: ReadonlyArray<keyof DerivedProfile['facets']> = [
  'role', 'tasks', 'workflow', 'artifacts', 'knowhow',
];

function entityDto(entity: ProductEntityCandidate, degraded: boolean): Record<string, unknown> {
  return common(entity.entityId, entity.entityType, entity.label, entity.summary, entity.revision, entity.updatedAt, degraded);
}
function itemDto(item: ProductItemCandidate, evidence: Record<string, unknown>[]): Record<string, unknown> {
  return {
    ...common(item.itemId, item.itemType, item.semanticKey, summary(item.value), item.revision, item.updatedAt, false),
    authority: authority(item.scope.type === 'person' ? 'personal' : 'organization', item.authority), evidence,
  };
}

function profileFacetDto(facet: keyof DerivedProfile['facets'], entry: ProfileFacetEntry,
  entity: ProductEntityCandidate, evidence: Record<string, unknown>[]): Record<string, unknown> {
  return {
    ...common(entry.itemId, facet, entry.semanticKey, summary(entry.value), entity.revision, entity.updatedAt, false),
    authority: authority(entry.authority === 'user' ? 'personal' : 'organization', entry.authority),
    evidence, conflict: null, review: null,
  };
}

function reviewDto(item: ProductReviewCandidate, entity: ProductEntityCandidate, evidence: Record<string, unknown>[]) {
  return {
    ...common(item.itemId, item.itemType, item.semanticKey, summary(item.value), item.revision, item.updatedAt, false),
    entityId: entity.entityId, entityLabel: entity.label, status: item.state,
    originalSummary: item.originalSummary, proposedSummary: summary(item.value) ?? item.semanticKey,
    conflict: item.conflict, authority: authority(item.scope.type === 'person' ? 'personal' : 'organization', item.authority), evidence,
  };
}
function common(id: string, type: string, label: string, summaryValue: string | null, revision: number,
  updatedAt: string, degraded: boolean) {
  return { id, type, label: label || type, summary: summaryValue, revision, updatedAt, degraded };
}
function authority(scope: 'personal' | 'organization', value: string) {
  return { scope, label: value === 'steward' || value === 'authoritative' ? '组织校正'
    : value === 'user' || value === 'advisory' ? '个人校正' : '来源事实' };
}
function summary(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 500) || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  for (const key of ['summary', 'label', 'title', 'status', 'value']) {
    const candidate = object[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 500);
  }
  return null;
}
function personalVisible(item: Pick<ProductItemCandidate, 'scope'>, viewerId: string): boolean {
  return item.scope.type === 'org' || item.scope.personId === viewerId;
}

function assigned(scope: ContextRecallResolvedScope): string[] {
  return [...new Set(scope.collections.filter(item => item.resourceType === 'org_knowledge').map(item => item.collectionId))];
}
function correctionAuthorizationFingerprint(snapshot: DerivedReviewAuthorizationSnapshot): string {
  const evidence = snapshot.evidence.map(ref => ({ ...ref })).sort((left, right) =>
    `${left.sourceId}\u0000${left.collectionId}\u0000${left.recordId}\u0000${left.recordRevision}\u0000${left.evidenceId}`
      .localeCompare(`${right.sourceId}\u0000${right.collectionId}\u0000${right.recordId}\u0000${right.recordRevision}\u0000${right.evidenceId}`));
  return createHash('sha256').update(JSON.stringify({
    tenantId: snapshot.tenantId,
    entityId: snapshot.entityId,
    generation: snapshot.generation,
    itemId: snapshot.itemId,
    itemType: snapshot.itemType,
    semanticKey: snapshot.semanticKey,
    valueFingerprint: snapshot.valueFingerprint,
    ownerPrincipal: snapshot.ownerPrincipal,
    evidence,
    scope: snapshot.scope,
  })).digest('hex');
}
function sameRef(left: DerivedEvidenceRef, right: Readonly<DerivedEvidenceRef>): boolean {
  return left.sourceId === right.sourceId && left.collectionId === right.collectionId
    && left.recordId === right.recordId && left.recordRevision === right.recordRevision
    && left.evidenceId === right.evidenceId;
}
function dedupeEvidence(values: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...new Map(values.map(value => [String(value.id), value])).values()];
}
function relationStep(edge: RelationEdgeCandidate, frontier: Map<string, ProductEntityCandidate>) {
  if (frontier.has(edge.from.entityId)) return { fromId: edge.from.entityId, neighborId: edge.to.entityId };
  if (frontier.has(edge.to.entityId)) return { fromId: edge.to.entityId, neighborId: edge.from.entityId };
  return null;
}
function relationActive(edge: RelationEdgeCandidate, now: Date): boolean {
  const validFrom = Date.parse(edge.validFrom);
  const validTo = edge.validTo ? Date.parse(edge.validTo) : Number.POSITIVE_INFINITY;
  return edge.lifecycle === 'active' && edge.reviewStatus !== 'rejected'
    && Number.isFinite(validFrom) && validFrom <= now.getTime() && validTo > now.getTime();
}
function mapDerivedError(error: unknown): Error {
  if (!(error instanceof DerivedStoreError)) return error instanceof ContextProductError
    ? error : new ContextProductError('CONTEXT_PRODUCT_UNAVAILABLE');
  if (error.code === 'DERIVED_FORBIDDEN') return new ContextProductError('CONTEXT_PRODUCT_FORBIDDEN');
  if (error.code === 'DERIVED_NOT_FOUND' || error.code === 'DERIVED_EVIDENCE_INVALID') return new ContextProductError('CONTEXT_PRODUCT_NOT_FOUND');
  if (error.code === 'DERIVED_VERSION_CONFLICT') return new ContextProductError('CONTEXT_PRODUCT_CONFLICT');
  if (error.code === 'DERIVED_INVALID') return new ContextProductError('CONTEXT_PRODUCT_INVALID');
  return new ContextProductError('CONTEXT_PRODUCT_UNAVAILABLE');
}
