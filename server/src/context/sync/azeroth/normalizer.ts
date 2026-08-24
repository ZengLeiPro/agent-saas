import { createHash } from 'node:crypto';

import type {
  ContextEntityType,
  ContextIngestRecordInput,
  ContextJson,
  ContextObject,
  ContextRecordKind,
} from '../../store/index.js';
import type { AzerothEntity } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}[- ]?\d{7,8}(?!\d)/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const WEBSITE_SIGNAL_EVENTS = new Set([
  'consult_cta_click',
  'consult_channel_phone_click',
  'consult_channel_mail_click',
  'consult_channel_dingtalk_click',
  'consult_form_submit',
  'lead_signup_click',
  'lead_submit',
  'quote_request_submit',
  'resource_download',
]);

interface EntityMapping {
  entityType?: ContextEntityType;
  recordKind: ContextRecordKind;
  businessObjectType: string;
  idField: 'id' | 'reportId' | 'eventId';
  contentFields: readonly string[];
  occurredFields: readonly string[];
  ownerFields: readonly string[];
  aclFields: readonly string[];
}

const MAPPINGS: Record<AzerothEntity, EntityMapping> = {
  customers: {
    entityType: 'customer', recordKind: 'snapshot', businessObjectType: 'customer', idField: 'id',
    contentFields: ['serialNumber', 'customerName', 'shortName', 'industry', 'customerLevel', 'customerSource', 'customerRelationship', 'customerTags', 'status'],
    occurredFields: ['createdAt'], ownerFields: ['chargerId'], aclFields: ['chargerId', 'collaboratorIds'],
  },
  contacts: {
    entityType: 'person', recordKind: 'snapshot', businessObjectType: 'contact', idField: 'id',
    contentFields: ['contactName', 'customerName', 'position', 'department', 'isKp', 'kpRole', 'status'],
    occurredFields: ['createdAt'], ownerFields: [], aclFields: [],
  },
  employees: {
    entityType: 'person', recordKind: 'snapshot', businessObjectType: 'employee', idField: 'id',
    contentFields: ['name', 'serialNumber', 'position', 'status', 'departmentName', 'isAdmin', 'isBoss', 'isLeader', 'dingtalkActive'],
    occurredFields: ['createdAt'], ownerFields: ['id'], aclFields: ['id'],
  },
  opportunities: {
    recordKind: 'snapshot', businessObjectType: 'opportunity', idField: 'id',
    contentFields: ['serialNumber', 'opportunityName', 'customerName', 'opportunityStage', 'opportunityAmount', 'winRate', 'expectedDealDate', 'realDealDate'],
    occurredFields: ['createdAt', 'expectedDealDate'], ownerFields: ['chargerId'], aclFields: ['chargerId', 'collaboratorIds'],
  },
  'keep-records': {
    recordKind: 'event', businessObjectType: 'keepRecord', idField: 'id',
    contentFields: ['keepRecordType', 'keepRecordTime', 'keepRecordContent', 'keepRecordStatus', 'source'],
    occurredFields: ['keepRecordTime', 'createdAt'], ownerFields: ['chargerId'], aclFields: ['chargerId'],
  },
  projects: {
    entityType: 'project', recordKind: 'snapshot', businessObjectType: 'project', idField: 'id',
    contentFields: ['name', 'description', 'status', 'logicalStatus', 'category', 'startDate', 'endDate', 'totalHours'],
    occurredFields: ['startDate', 'createdAt'], ownerFields: ['ownerId'], aclFields: ['ownerId', 'members'],
  },
  'project-tickets': {
    entityType: 'task', recordKind: 'snapshot', businessObjectType: 'projectTicket', idField: 'id',
    contentFields: ['ticketNo', 'title', 'description', 'ticketType', 'priority', 'status', 'dueDate', 'startedAt', 'completedAt', 'closedAt', 'cancelledAt', 'completionNote', 'closeNote', 'cancelReason'],
    occurredFields: ['createdAt', 'startedAt'], ownerFields: ['assigneeId'], aclFields: ['assigneeId', 'dispatcherId'],
  },
  'effort-records': {
    recordKind: 'event', businessObjectType: 'effortRecord', idField: 'id',
    contentFields: ['projectName', 'actualTime', 'description', 'workType', 'workDate', 'recordType', 'startDate', 'endDate'],
    occurredFields: ['workDate', 'createdAt'], ownerFields: ['ownerId'], aclFields: ['ownerId'],
  },
  'dingtalk-logs': {
    recordKind: 'event', businessObjectType: 'dingtalkLog', idField: 'reportId',
    contentFields: ['templateName', 'deptName', 'contents', 'contentsJson', 'source', 'isLocallyEdited'],
    occurredFields: ['createTime', 'updatedAt', 'syncedAt'], ownerFields: ['creatorId'], aclFields: ['creatorId'],
  },
  'dingtalk-calendar-events': {
    entityType: 'meeting', recordKind: 'snapshot', businessObjectType: 'calendarEvent', idField: 'eventId',
    // location, creator and attendees are intentionally omitted: the API contract does not establish employee UUIDs.
    contentFields: ['title', 'description', 'startTime', 'endTime'],
    occurredFields: ['startTime', 'syncedAt'], ownerFields: [], aclFields: [],
  },
  'sales-action-items': {
    entityType: 'task', recordKind: 'snapshot', businessObjectType: 'salesActionItem', idField: 'id',
    contentFields: ['category', 'priority', 'refType', 'title', 'customerName', 'reason', 'suggestedAction', 'confidence', 'status', 'resolveNote', 'doneType', 'snoozeUntil', 'remindCount', 'resultType', 'resultId'],
    occurredFields: ['createdAt', 'snoozeUntil'], ownerFields: ['employeeId'],
    aclFields: ['employeeId', 'creatorEmployeeId', 'updaterEmployeeId', 'resolvedById'],
  },
  'web-events': {
    recordKind: 'event', businessObjectType: 'websiteEvent', idField: 'id',
    // Browser/session IDs, referrer, user-agent, IP hash and raw payload stay outside Context Plane.
    contentFields: ['receivedAt', 'site', 'event', 'path', 'pageType', 'title', 'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent', 'placement', 'channel', 'label', 'country', 'region', 'city'],
    occurredFields: ['receivedAt', 'clientTs'], ownerFields: [], aclFields: [],
  },
};

export function shouldIngestAzerothRow(entity: AzerothEntity, row: Record<string, unknown>): boolean {
  if (entity !== 'web-events') return true;
  return row.isBot !== true && typeof row.event === 'string' && WEBSITE_SIGNAL_EVENTS.has(row.event);
}

export function azerothNativeId(entity: AzerothEntity, row: Record<string, unknown>): string {
  const mapping = MAPPINGS[entity];
  return requiredString(row[mapping.idField], `${entity}.${mapping.idField}`);
}

export function normalizeAzerothRecord(
  entity: AzerothEntity,
  row: Record<string, unknown>,
  observedAt: string,
): ContextIngestRecordInput {
  const mapping = MAPPINGS[entity];
  const nativeId = azerothNativeId(entity, row);
  const externalRecordId = externalId(entity, nativeId);
  const sourceUpdatedAt = firstDate(row.updatedAt, row.syncedAt, row.createdAt, ...mapping.occurredFields.map(field => row[field]));
  const occurredAt = firstDate(...mapping.occurredFields.map(field => row[field]));
  const revisionToken = sourceRevision(row, sourceUpdatedAt);
  const ownerPrincipal = mapping.ownerFields
    .map(field => employeePrincipal(row[field]))
    .find((value): value is string => Boolean(value));
  const aclPrincipals = collectAcl(row, mapping.aclFields);
  const relations = relationMetadata(row);
  const content = safeContent(row, mapping.contentFields);
  const metadata: ContextObject = {
    provider: 'azeroth',
    entity,
    businessObjectType: mapping.businessObjectType,
    sourceRevision: {
      version: typeof row.version === 'number' ? row.version : null,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    },
    // Phase 3 projects these stable native relations deterministically.
    ...relations,
  };
  const evidenceData: ContextObject = {
    source: 'azeroth',
    entity,
    nativeId,
    path: `/api/v1/${entity}`,
    ...(occurredAt ? { businessTime: occurredAt } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
  return {
    recordId: `azeroth-${digest(`${entity}\0${nativeId}`).slice(0, 48)}`,
    externalRecordId,
    content,
    metadata,
    ...(mapping.entityType ? { entityType: mapping.entityType } : {}),
    recordKind: mapping.recordKind,
    nativeId,
    ...(occurredAt ? { occurredAt } : {}),
    sourceEventId: `azeroth:${entity}:${nativeId}:${revisionToken}`,
    ...(ownerPrincipal ? { ownerPrincipal } : {}),
    // Empty is deliberate fail-closed ACL, not organization-wide visibility.
    aclPrincipals,
    deleted: Boolean(row.deletedAt),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    observedAt,
    evidence: [{
      evidenceId: `source-locator-${digest(`${entity}\0${nativeId}`).slice(0, 40)}`,
      kind: 'source_locator',
      data: evidenceData,
    }],
  };
}

export function createAzerothRevocation(
  entity: AzerothEntity,
  externalRecordId: string,
  completedAt: string,
): ContextIngestRecordInput {
  const prefix = `azeroth:${entity}:`;
  const nativeId = externalRecordId.startsWith(prefix) ? externalRecordId.slice(prefix.length) : externalRecordId;
  const mapping = MAPPINGS[entity];
  return {
    recordId: `azeroth-${digest(`${entity}\0${nativeId}`).slice(0, 48)}`,
    externalRecordId,
    content: null,
    metadata: {
      provider: 'azeroth',
      entity,
      businessObjectType: mapping.businessObjectType,
      revocationReason: 'inventory_absent',
    },
    ...(mapping.entityType ? { entityType: mapping.entityType } : {}),
    recordKind: mapping.recordKind,
    nativeId,
    sourceEventId: `azeroth:${entity}:${nativeId}:revoked:${completedAt}`,
    aclPrincipals: [],
    revoked: true,
    observedAt: completedAt,
  };
}

export function azerothExternalId(entity: AzerothEntity, nativeId: string): string {
  return externalId(entity, nativeId);
}

function safeContent(row: Record<string, unknown>, fields: readonly string[]): ContextObject {
  const content: ContextObject = {};
  for (const field of fields) {
    const value = sanitizeJson(row[field]);
    if (value !== undefined && value !== null && value !== '') content[field] = value;
  }
  return content;
}

function sanitizeJson(value: unknown): ContextJson | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return redactPii(value);
  if (Array.isArray(value)) {
    return value.map(sanitizeJson).filter((item): item is ContextJson => item !== undefined);
  }
  if (typeof value === 'object') {
    const result: ContextObject = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:phone|mobile|email|address|location)$/i.test(key)) continue;
      const sanitized = sanitizeJson(child);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return undefined;
}

function redactPii(value: string): string {
  return value.replace(PHONE, '[PHONE_REDACTED]').replace(EMAIL, '[EMAIL_REDACTED]');
}

function collectAcl(row: Record<string, unknown>, fields: readonly string[]): string[] {
  const principals = new Set<string>();
  for (const field of fields) {
    const value = row[field];
    if (field === 'members' && Array.isArray(value)) {
      for (const member of value) {
        if (!member || typeof member !== 'object' || Array.isArray(member)) continue;
        const candidate = member as Record<string, unknown>;
        if (candidate.isActive === false) continue;
        const principal = employeePrincipal(candidate.employeeId);
        if (principal) principals.add(principal);
      }
      continue;
    }
    for (const candidate of Array.isArray(value) ? value : [value]) {
      const principal = employeePrincipal(candidate);
      if (principal) principals.add(principal);
    }
  }
  return [...principals].sort();
}

function employeePrincipal(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value)
    ? `azeroth-employee:${value.toLowerCase()}`
    : undefined;
}

function relationMetadata(row: Record<string, unknown>): ContextObject {
  const result: ContextObject = {};
  for (const key of ['customerId', 'projectId', 'refId', 'contactId', 'opportunityId', 'saleOrderId'] as const) {
    if (typeof row[key] === 'string' && row[key].trim()) result[key] = row[key];
  }
  if (result.customerId === undefined && row.customer && typeof row.customer === 'object' && !Array.isArray(row.customer)) {
    const customerId = (row.customer as Record<string, unknown>).id;
    if (typeof customerId === 'string' && customerId.trim()) result.customerId = customerId;
  }
  return result;
}

function sourceRevision(row: Record<string, unknown>, sourceUpdatedAt: string | undefined): string {
  if (typeof row.version === 'number' && Number.isSafeInteger(row.version)) return String(row.version);
  if (typeof row.updatedAt === 'string' && row.updatedAt) return row.updatedAt;
  if (sourceUpdatedAt) return sourceUpdatedAt;
  throw new Error('Azeroth row has neither version nor a usable source timestamp');
}

function firstDate(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    const millis = Date.parse(value);
    if (Number.isFinite(millis)) return new Date(millis).toISOString();
  }
  return undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}

function externalId(entity: AzerothEntity, nativeId: string): string {
  return `azeroth:${entity}:${nativeId}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
