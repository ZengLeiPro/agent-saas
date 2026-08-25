import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { DerivedEvidenceRef } from '../derived/types.js';
import {
  ContextSourceAuthorizationRegistry,
  contextSourceLocatorFromRow,
  type ContextSourceLocator,
} from '../retrieval/sourceAuthorization.js';
import type { ContextRecallResolvedScope } from '../retrieval/types.js';
import { ContextProductError, type ContextProductSubject, type ProductRecordLocator } from './types.js';

const MAX_TOKEN_LENGTH = 2_000;
const EVIDENCE_PREFIX = 'ce1';
const EVIDENCE_NONCE_BYTES = 12;
const EVIDENCE_TAG_BYTES = 16;
const EVIDENCE_AAD = Buffer.from('context-product:ce1:aes-256-gcm', 'utf8');

/** Enforces assignment, current-record state and native ACL in that order. */
export class ContextProductAuthorization {
  private readonly evidenceKey: Buffer;

  constructor(
    private readonly registry: ContextSourceAuthorizationRegistry,
    private readonly signingKey: string | Buffer,
  ) {
    const key = Buffer.isBuffer(signingKey) ? signingKey : Buffer.from(signingKey, 'utf8');
    if (key.length < 32) throw new ContextProductError('CONTEXT_PRODUCT_UNAVAILABLE');
    this.evidenceKey = createHmac('sha256', key)
      .update('context-product:evidence:aes-256-gcm:v1')
      .digest();
  }

  async authorizeRecord(
    subject: ContextProductSubject,
    scope: ContextRecallResolvedScope,
    candidate: ProductRecordLocator,
  ): Promise<boolean> {
    const [authorized] = await this.authorizeRecords(subject, scope, [candidate]);
    return authorized === true;
  }

  async authorizeRecords(
    subject: ContextProductSubject,
    scope: ContextRecallResolvedScope,
    candidates: readonly ProductRecordLocator[],
  ): Promise<readonly boolean[]> {
    const allowedCollections = new Set(scope.collections
      .filter(item => item.resourceType === 'org_knowledge')
      .map(item => item.collectionId));
    const decisions = candidates.map(() => false);
    const eligible: Array<{ index: number; candidate: ProductRecordLocator }> = [];
    candidates.forEach((candidate, index) => {
      if (!allowedCollections.has(candidate.collectionId)
        || candidate.currentDeleted || candidate.currentRevoked || candidate.refused
        || candidate.currentRevision < 1 || candidate.recordRevision < 1
        || candidate.recordRevision > candidate.currentRevision) return;
      eligible.push({ index, candidate });
    });
    if (!eligible.length) return decisions;
    const authorized = await this.registry.authorizeBatch(
      { tenantId: subject.tenantId, userId: subject.actorId },
      eligible.map(item => sourceLocator(item.candidate)),
    );
    eligible.forEach((item, index) => { decisions[item.index] = authorized[index]?.authorized === true; });
    return decisions;
  }

  evidenceHandle(tenantId: string, ref: DerivedEvidenceRef): string {
    const nonce = randomBytes(EVIDENCE_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.evidenceKey, nonce, { authTagLength: EVIDENCE_TAG_BYTES });
    cipher.setAAD(EVIDENCE_AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ t: tenantId, ...ref }), 'utf8'), cipher.final()]);
    return `${EVIDENCE_PREFIX}.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  parseEvidenceHandle(tenantId: string, handle: string): DerivedEvidenceRef {
    try {
      const [prefix, encodedNonce, encodedCiphertext, encodedTag, extra] = typeof handle === 'string' ? handle.split('.') : [];
      if (handle.length > MAX_TOKEN_LENGTH || prefix !== EVIDENCE_PREFIX || extra !== undefined
        || !encodedNonce || !encodedCiphertext || !encodedTag) evidenceInvalid();
      const nonce = decodeBase64Url(encodedNonce, EVIDENCE_NONCE_BYTES);
      const ciphertext = decodeBase64Url(encodedCiphertext);
      const tag = decodeBase64Url(encodedTag, EVIDENCE_TAG_BYTES);
      if (ciphertext.length < 1 || ciphertext.length > 1_500) evidenceInvalid();
      const decipher = createDecipheriv('aes-256-gcm', this.evidenceKey, nonce, { authTagLength: EVIDENCE_TAG_BYTES });
      decipher.setAAD(EVIDENCE_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.length > 1_500) evidenceInvalid();
      const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) evidenceInvalid();
      const value = parsed as Record<string, unknown>;
      if (value.t !== tenantId || !validId(value.sourceId) || !validId(value.collectionId)
        || !validId(value.recordId) || !validId(value.evidenceId)
        || !Number.isSafeInteger(value.recordRevision) || Number(value.recordRevision) < 1) evidenceInvalid();
      return {
        sourceId: String(value.sourceId), collectionId: String(value.collectionId),
        recordId: String(value.recordId), recordRevision: Number(value.recordRevision),
        evidenceId: String(value.evidenceId),
      };
    } catch (error) {
      if (error instanceof ContextProductError && error.code === 'CONTEXT_PRODUCT_EVIDENCE_INVALID') throw error;
      return evidenceInvalid();
    }
  }

  cursor(subject: ContextProductSubject, fingerprint: string, offset: number): string {
    return this.sign('cp1', { t: subject.tenantId, a: subject.actorId, f: fingerprint, o: offset });
  }

  parseCursor(subject: ContextProductSubject, fingerprint: string, cursor: string): number {
    const parsed = this.verify('cp1', cursor);
    if (parsed.t !== subject.tenantId || parsed.a !== subject.actorId || parsed.f !== fingerprint
      || !Number.isSafeInteger(parsed.o) || Number(parsed.o) < 0 || Number(parsed.o) > 100_000) {
      throw new ContextProductError('CONTEXT_PRODUCT_CURSOR_INVALID');
    }
    return Number(parsed.o);
  }

  entityCursor(subject: ContextProductSubject, fingerprint: string, entityId: string): string {
    if (!validId(entityId)) throw new ContextProductError('CONTEXT_PRODUCT_CURSOR_INVALID');
    return this.sign('cp2', { t: subject.tenantId, a: subject.actorId, f: fingerprint, e: entityId });
  }

  parseEntityCursor(subject: ContextProductSubject, fingerprint: string, cursor: string): string {
    const parsed = this.verify('cp2', cursor);
    if (parsed.t !== subject.tenantId || parsed.a !== subject.actorId || parsed.f !== fingerprint
      || !validId(parsed.e)) throw new ContextProductError('CONTEXT_PRODUCT_CURSOR_INVALID');
    return String(parsed.e);
  }

  private sign(prefix: string, value: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${prefix}.${payload}.${signature(prefix, payload, this.signingKey)}`;
  }

  private verify(prefix: string, token: string): Record<string, unknown> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
      throw new ContextProductError(prefix === 'cp1' || prefix === 'cp2'
        ? 'CONTEXT_PRODUCT_CURSOR_INVALID' : 'CONTEXT_PRODUCT_EVIDENCE_INVALID');
    }
    const [actualPrefix, payload, provided, extra] = token.split('.');
    const expected = payload ? signature(prefix, payload, this.signingKey) : '';
    if (actualPrefix !== prefix || !payload || !provided || extra || !safeEqual(provided, expected)) {
      throw new ContextProductError(prefix === 'cp1' || prefix === 'cp2'
        ? 'CONTEXT_PRODUCT_CURSOR_INVALID' : 'CONTEXT_PRODUCT_EVIDENCE_INVALID');
    }
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      return parsed as Record<string, unknown>;
    } catch {
      throw new ContextProductError(prefix === 'cp1' || prefix === 'cp2'
        ? 'CONTEXT_PRODUCT_CURSOR_INVALID' : 'CONTEXT_PRODUCT_EVIDENCE_INVALID');
    }
  }
}

function sourceLocator(value: ProductRecordLocator): ContextSourceLocator {
  // Reuse the recall path's canonical native locator derivation. Metadata and ACL are
  // always from the current record; historical evidence revision fields are not used.
  return contextSourceLocatorFromRow({
    source_kind: value.sourceKind, source_id: value.sourceId, collection_id: value.collectionId,
    record_id: value.recordId, current_revision: value.currentRevision, record_kind: value.recordType,
    metadata_json: value.metadata, owner_principal: value.ownerPrincipal,
    acl_principals: value.aclPrincipals ?? [], source_event_id: value.sourceEventId,
    event_type: value.eventType, deleted: value.currentDeleted,
  });
}

function validId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f]/u.test(value);
}

function decodeBase64Url(value: string, expectedLength?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return evidenceInvalid();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    return evidenceInvalid();
  }
  return decoded;
}

function evidenceInvalid(): never {
  throw new ContextProductError('CONTEXT_PRODUCT_EVIDENCE_INVALID');
}

function signature(prefix: string, payload: string, key: string | Buffer): string {
  return createHmac('sha256', key).update(`context-product:${prefix}:${payload}`).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
