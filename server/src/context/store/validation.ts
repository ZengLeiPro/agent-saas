import { createHash } from 'node:crypto';

import {
  ContextStoreError,
  type ContextIngestRecordInput,
  type ContextJson,
  type ContextObject,
  type ContextResourceStatus,
} from './types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,119}$/;
const RESOURCE_STATUSES = new Set<ContextResourceStatus>(['active', 'disabled', 'revoked', 'deleted']);
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
