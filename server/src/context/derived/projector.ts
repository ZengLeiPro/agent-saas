import { createHash } from 'node:crypto';

import type { ContextJson, ContextObject } from '../store/types.js';
import {
  DERIVED_ENTITY_TYPES,
  DERIVED_ITEM_TYPES,
  type ClaimedContextRecord,
  type DerivedEntityCandidate,
  type DerivedEntityType,
  type DerivedEvidenceRef,
  type DerivedItemCandidate,
  type DerivedItemType,
  type DerivedProjection,
  type DerivedRelationCandidate,
} from './types.js';

const entityTypes = new Set<string>(DERIVED_ENTITY_TYPES);
const itemTypes = new Set<string>(DERIVED_ITEM_TYPES);

type JsonMap = Record<string, ContextJson>;

/** Pure, deterministic projection. It deliberately has no LLM/name matching path. */
export class DeterministicContextProjector {
  project(record: ClaimedContextRecord): DerivedProjection {
    if (record.deleted || record.revoked || record.eventType !== 'context.record.upserted') {
      return { entities: [], relations: [], items: [] };
    }
    const evidence = evidenceRefs(record);
    const descriptors = explicitDescriptors(record);
    const entities = new Map<string, DerivedEntityCandidate>();
    const relations = new Map<string, DerivedRelationCandidate>();
    const items = new Map<string, DerivedItemCandidate>();

    for (const descriptor of descriptors) {
      const entity = toEntity(record, descriptor);
      if (!entity) continue;
      entities.set(entity.entityId, entity);
      if (evidence.length === 0) continue;

      for (const item of descriptorItems(record, descriptor, entity, evidence)) {
        items.set(item.itemId, item);
      }

      for (const relation of explicitRelations(record, descriptor, entity, evidence)) {
        relations.set(relation.relationId, relation);
      }
    }
    return { entities: [...entities.values()], relations: [...relations.values()], items: [...items.values()] };
  }
}

function explicitRelations(
  record: ClaimedContextRecord,
  descriptor: JsonMap,
  from: DerivedEntityCandidate,
  evidence: DerivedEvidenceRef[],
): DerivedRelationCandidate[] {
  const refs: Array<{ type: DerivedEntityType; stableId?: string; relationType: DerivedRelationCandidate['relationType'] }> = [];
  const nestedStableId = (key: string): string | undefined => {
    const value = asMap(descriptor[key]);
    return stableString(value?.id) ?? stableString(value?.stableId) ?? stableString(value?.externalId);
  };
  if (from.entityType === 'Task') {
    refs.push({ type: 'Project', stableId: stableString(descriptor.projectId) ?? nestedStableId('project'), relationType: 'task_of' });
    refs.push({ type: 'Person', stableId: stableString(descriptor.assigneeId), relationType: 'mentions' });
    refs.push({ type: 'Person', stableId: stableString(descriptor.ownerId), relationType: 'mentions' });
  } else if (from.entityType === 'Project') {
    refs.push({ type: 'Customer', stableId: stableString(descriptor.customerId) ?? nestedStableId('customer'), relationType: 'project_of' });
    refs.push({ type: 'Person', stableId: stableString(descriptor.ownerId), relationType: 'mentions' });
  } else if (from.entityType === 'Meeting') {
    refs.push({ type: 'Project', stableId: stableString(descriptor.projectId) ?? nestedStableId('project'), relationType: 'meeting_of' });
    refs.push({ type: 'Person', stableId: stableString(descriptor.organizerId), relationType: 'mentions' });
  } else if (from.entityType === 'Customer') {
    refs.push({ type: 'Person', stableId: stableString(descriptor.ownerId), relationType: 'mentions' });
  }

  const validFrom = dateString(descriptor.validFrom) ?? dateString(descriptor.occurredAt)
    ?? record.occurredAt ?? record.sourceUpdatedAt ?? record.observedAt;
  const validTo = dateString(descriptor.validTo);
  const result: DerivedRelationCandidate[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref.stableId) continue;
    const toEntityId = entityId(record.tenantId, ref.type, ref.stableId, record.sourceId);
    const relationId = digest(['relation', record.tenantId, from.entityId, toEntityId, ref.relationType].join('\0'));
    if (seen.has(relationId)) continue;
    seen.add(relationId);
    result.push({
      relationId,
      fromEntityId: from.entityId,
      toEntityId,
      relationType: ref.relationType,
      relationClass: 'explicit',
      authority: 'informational',
      reviewStatus: 'confirmed',
      sourceId: record.sourceId,
      collectionId: record.collectionId,
      recordId: record.recordId,
      recordRevision: record.recordRevision,
      validFrom,
      ...(validTo ? { validTo } : {}),
      evidence,
    });
  }
  return result;
}

function explicitDescriptors(record: ClaimedContextRecord): JsonMap[] {
  const content = asMap(record.content);
  const result: JsonMap[] = [];
  const typedEntity = typedEntityType(record.entityType);
  if (typedEntity && record.nativeId) {
    result.push({ ...(content ?? {}), entityType: typedEntity, id: record.nativeId,
      ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}) });
  }
  // Arbitrary source content cannot self-declare an entity. Only the trusted typed
  // revision envelope above, or the two narrow DWS stable-ID mappings below, is admitted.

  // DWS identities are admitted only from explicit, stable metadata identifiers.
  const source = stableString(record.metadata.source);
  const sourceStableId = stableString(record.metadata.sourceId);
  if (source === 'minutes') {
    const minutesId = stableString(record.metadata.minutesId) ?? sourceStableId;
    if (minutesId) result.push({ entityType: 'Meeting', id: minutesId, title: content?.title ?? null });
  }
  if (source === 'chat') {
    const senderId = stableString(record.metadata.senderId);
    if (senderId) result.push({ entityType: 'Person', id: senderId });
  }
  return dedupeDescriptors(result);
}

function dedupeDescriptors(values: JsonMap[]): JsonMap[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const type = entityType(value.entityType ?? value.type);
    const id = stableId(value);
    if (!type || !id) return false;
    const key = `${type}\0${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toEntity(record: ClaimedContextRecord, descriptor: JsonMap): DerivedEntityCandidate | undefined {
  const type = entityType(descriptor.entityType ?? descriptor.type);
  const stableKey = stableId(descriptor);
  if (!type || !stableKey) return undefined;
  const label = stableString(descriptor.label) ?? stableString(descriptor.title) ?? stableString(descriptor.name);
  return {
    entityId: entityId(record.tenantId, type, stableKey, record.sourceId),
    entityType: type,
    stableKey,
    ...(label ? { label } : {}),
    metadata: publicMetadata(descriptor),
    sourceId: record.sourceId,
    collectionId: record.collectionId,
    recordId: record.recordId,
    recordRevision: record.recordRevision,
    ...(record.ownerPrincipal ? { ownerPrincipal: record.ownerPrincipal } : {}),
    ...(record.aclPrincipals ? { aclPrincipals: record.aclPrincipals } : {}),
  };
}

function descriptorItems(
  record: ClaimedContextRecord,
  descriptor: JsonMap,
  entity: DerivedEntityCandidate,
  evidence: DerivedEvidenceRef[],
): DerivedItemCandidate[] {
  const candidates: Array<{ itemType: DerivedItemType; semanticKey: string; value: ContextJson }> = [];
  if (entity.entityType === 'Task') {
    const taskValue: JsonMap = {};
    for (const key of ['title', 'description', 'ownerId', 'assigneeId', 'dueAt'] as const) {
      if (descriptor[key] !== undefined) taskValue[key] = descriptor[key]!;
    }
    if (Object.keys(taskValue).length > 0) candidates.push({ itemType: 'Task', semanticKey: 'task', value: taskValue });
  }
  if (descriptor.status !== undefined && isStructuredValue(descriptor.status)) {
    candidates.push({ itemType: 'Status', semanticKey: 'status', value: descriptor.status });
  }
  if (Array.isArray(descriptor.items)) {
    for (const raw of descriptor.items) {
      const item = asMap(raw);
      const type = itemType(item?.itemType ?? item?.type);
      const semanticKey = stableString(item?.semanticKey);
      if (!item || !type || !semanticKey || item.value === undefined) continue;
      candidates.push({ itemType: type, semanticKey, value: item.value });
    }
  }
  return candidates.map(candidate => makeItem(record, descriptor, entity, evidence, candidate));
}

function makeItem(
  record: ClaimedContextRecord,
  descriptor: JsonMap,
  entity: DerivedEntityCandidate,
  evidence: DerivedEvidenceRef[],
  input: { itemType: DerivedItemType; semanticKey: string; value: ContextJson },
): DerivedItemCandidate {
  const valueFingerprint = fingerprint(input.value);
  const occurredAt = dateString(descriptor.occurredAt) ?? dateString(record.metadata.occurredAt)
    ?? record.occurredAt ?? record.sourceUpdatedAt ?? record.observedAt;
  const validFrom = dateString(descriptor.validFrom) ?? occurredAt;
  const itemId = digest([
    'source-item', record.tenantId, entity.entityId, input.itemType, input.semanticKey,
    record.sourceId, record.collectionId, record.recordId, String(record.recordRevision), valueFingerprint,
  ].join('\0'));
  return {
    itemId,
    entityId: entity.entityId,
    itemType: input.itemType,
    semanticKey: input.semanticKey,
    value: input.value,
    valueFingerprint,
    derivation: 'source',
    authority: 'source',
    state: 'confirmed',
    scope: { type: 'org' },
    sourceId: record.sourceId,
    collectionId: record.collectionId,
    recordId: record.recordId,
    recordRevision: record.recordRevision,
    ...(record.ownerPrincipal ? { ownerPrincipal: record.ownerPrincipal } : {}),
    ...(record.aclPrincipals ? { aclPrincipals: record.aclPrincipals } : {}),
    validFrom,
    ...dateField('validTo', descriptor.validTo),
    occurredAt,
    observedAt: record.observedAt,
    evidence,
  };
}

function evidenceRefs(record: ClaimedContextRecord): DerivedEvidenceRef[] {
  return record.evidence.map(value => ({
    sourceId: record.sourceId,
    collectionId: record.collectionId,
    recordId: record.recordId,
    recordRevision: record.recordRevision,
    evidenceId: value.evidenceId,
  }));
}

export function entityId(tenantId: string, type: DerivedEntityType, stableKey: string, sourceId: string): string {
  // Native IDs are source-scoped. Cross-source same_as is never inferred by this projector.
  return `ctx-${type.toLowerCase()}-${digest([tenantId, sourceId, type, stableKey].join('\0')).slice(0, 48)}`;
}

export function fingerprint(value: ContextJson): string {
  return digest(canonicalJson(value).normalize('NFKC'));
}

export function canonicalJson(value: ContextJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function entityType(value: ContextJson | undefined): DerivedEntityType | undefined {
  return typeof value === 'string' && entityTypes.has(value) ? value as DerivedEntityType : undefined;
}

function typedEntityType(value: ClaimedContextRecord['entityType']): DerivedEntityType | undefined {
  if (!value) return undefined;
  return `${value[0]!.toUpperCase()}${value.slice(1)}` as DerivedEntityType;
}

function itemType(value: ContextJson | undefined): DerivedItemType | undefined {
  return typeof value === 'string' && itemTypes.has(value) ? value as DerivedItemType : undefined;
}

function stableId(value: JsonMap): string | undefined {
  return stableString(value.id) ?? stableString(value.stableId) ?? stableString(value.externalId);
}

function stableString(value: ContextJson | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result.length > 0 && result.length <= 500 ? result : undefined;
}

function asMap(value: ContextJson | undefined): JsonMap | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function publicMetadata(value: JsonMap): ContextObject {
  const result: ContextObject = {};
  for (const key of ['externalId', 'kind', 'customerId'] as const) {
    if (value[key] !== undefined) result[key] = value[key]!;
  }
  return result;
}

function isStructuredValue(value: ContextJson): boolean {
  return typeof value === 'string' || (value !== null && typeof value === 'object');
}

function dateString(value: ContextJson | undefined): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function dateField<K extends 'validFrom' | 'validTo'>(key: K, value: ContextJson | undefined): { [P in K]?: string } {
  const date = dateString(value);
  return date ? { [key]: date } as { [P in K]?: string } : {};
}
