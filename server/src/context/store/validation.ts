import { createHash } from 'node:crypto';

import {
  ContextStoreError,
  type ContextEntityType,
  type ContextIngestRecordInput,
  type ContextJson,
  type ContextObject,
  type ContextRecordKind,
  type ContextResourceStatus,
} from './types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,119}$/;
const RESOURCE_STATUSES = new Set<ContextResourceStatus>(['active', 'disabled', 'revoked', 'deleted']);
const ENTITY_TYPES = new Set<ContextEntityType>(['customer', 'project', 'person', 'meeting', 'task']);
const RECORD_KINDS = new Set<ContextRecordKind>(['snapshot', 'event']);
const MAX_NATIVE_ID_LENGTH = 1000;
const MAX_SOURCE_EVENT_ID_LENGTH = 1000;
const MAX_PRINCIPAL_LENGTH = 500;
const MAX_ACL_PRINCIPALS = 256;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

function invalid(): never {
  throw new ContextStoreError('CONTEXT_INVALID');
}

export function assertContextId(value: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) invalid();
}

export function assertContextText(value: string, maxLength = 500): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || value.includes('\0')) invalid();
}

export function assertContextRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
}

export function assertContextBigIntDecimal(value: string): void {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_BIGINT) invalid();
}

export function assertContextLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1000) invalid();
}

export function assertContextErrorCode(value: string): void {
  if (!ERROR_CODE_PATTERN.test(value)) invalid();
}

export function assertContextStatus(value: ContextResourceStatus): void {
  if (!RESOURCE_STATUSES.has(value)) invalid();
}

export function parseContextDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) invalid();
  return date.toISOString();
}

export function parseContextEnvelopeDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 100) invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) invalid();
  return parseContextDate(value);
}

export function normalizeContextAclPrincipals(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ACL_PRINCIPALS) invalid();
  const principals = new Set<string>();
  for (const principal of value) {
    assertContextText(principal, MAX_PRINCIPAL_LENGTH);
    principals.add(principal);
  }
  return [...principals].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function validateJson(value: unknown, seen: Set<object>): asserts value is ContextJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return;
  }
  if (!value || typeof value !== 'object') invalid();
  if (seen.has(value)) invalid();
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(child => validateJson(child, seen));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
    for (const [key, child] of Object.entries(value)) {
      if (!key || key.includes('\0') || child === undefined) invalid();
      validateJson(child, seen);
    }
  }
  seen.delete(value);
}

export function assertContextJson(value: unknown): asserts value is ContextJson {
  validateJson(value, new Set());
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JSON_BYTES) invalid();
}

export function assertContextObject(value: unknown): asserts value is ContextObject {
  assertContextJson(value);
  if (!value || Array.isArray(value) || typeof value !== 'object') invalid();
}

function canonicalJson(value: ContextJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}

export function computeContextContentHash(content: ContextJson): string {
  assertContextJson(content);
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/** Stable revision fingerprint; observedAt is deliberately excluded because it is ingestion time. */
export function computeContextVersionFingerprint(input: ContextIngestRecordInput): string {
  const evidence = [...(input.evidence ?? [])]
    .sort((left, right) => left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0)
    .map(item => ({ evidenceId: item.evidenceId, kind: item.kind, data: item.data }));
  const fingerprint: ContextObject = {
    content: input.content,
    contentHash: input.contentHash === undefined ? null : normalizeContextContentHash(input.content, input.contentHash),
    metadata: input.metadata ?? {},
    deleted: input.deleted ?? false,
    revoked: input.revoked ?? false,
    sourceUpdatedAt: parseContextDate(input.sourceUpdatedAt) ?? null,
    entityType: input.entityType ?? null,
    recordKind: input.recordKind ?? null,
    nativeId: input.nativeId ?? null,
    occurredAt: parseContextEnvelopeDate(input.occurredAt) ?? null,
    sourceEventId: input.sourceEventId ?? null,
    ownerPrincipal: input.ownerPrincipal ?? null,
    aclPrincipals: normalizeContextAclPrincipals(input.aclPrincipals) ?? null,
    evidence,
  };
  return computeContextContentHash(fingerprint);
}

export function normalizeContextContentHash(content: ContextJson, contentHash?: string): string {
  if (contentHash === undefined) return computeContextContentHash(content);
  if (!HASH_PATTERN.test(contentHash)) invalid();
  return contentHash.toLowerCase();
}

export function assertContextRecordInput(input: ContextIngestRecordInput): void {
  assertContextId(input.recordId);
  assertContextText(input.externalRecordId, 1000);
  assertContextJson(input.content);
  normalizeContextContentHash(input.content, input.contentHash);
  assertContextObject(input.metadata ?? {});
  parseContextDate(input.sourceUpdatedAt);
  parseContextDate(input.observedAt);
  if (input.entityType !== undefined && !ENTITY_TYPES.has(input.entityType)) invalid();
  if (input.recordKind !== undefined && !RECORD_KINDS.has(input.recordKind)) invalid();
  if (input.nativeId !== undefined) assertContextText(input.nativeId, MAX_NATIVE_ID_LENGTH);
  parseContextEnvelopeDate(input.occurredAt);
  if (input.sourceEventId !== undefined) assertContextText(input.sourceEventId, MAX_SOURCE_EVENT_ID_LENGTH);
  if (input.ownerPrincipal !== undefined) assertContextText(input.ownerPrincipal, MAX_PRINCIPAL_LENGTH);
  normalizeContextAclPrincipals(input.aclPrincipals);
  if (input.deleted !== undefined && typeof input.deleted !== 'boolean') invalid();
  if (input.revoked !== undefined && typeof input.revoked !== 'boolean') invalid();
  if ((input.evidence?.length ?? 0) > 100) invalid();
  const evidenceIds = new Set<string>();
  for (const evidence of input.evidence ?? []) {
    assertContextId(evidence.evidenceId);
    assertContextText(evidence.kind, 200);
    assertContextObject(evidence.data);
    if (evidenceIds.has(evidence.evidenceId)) invalid();
    evidenceIds.add(evidence.evidenceId);
  }
}
