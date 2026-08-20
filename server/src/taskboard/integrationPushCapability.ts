import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'ipc1';
const ZERO_OID = /^0+$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const INTEGRATION_REF = /^refs\/heads\/integration\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

export const DEFAULT_INTEGRATION_PUSH_CAPABILITY_TTL_MS = 2 * 60_000;
export const MAX_INTEGRATION_PUSH_CAPABILITY_TTL_MS = 5 * 60_000;

export interface IntegrationPushCapabilityBinding {
  tenantId: string;
  repositoryId: string;
  integrationTaskId: string;
  candidateId: string;
  revision: number;
  executionId: string;
  exactRef: string;
  expectedOldOid: string;
  laneEpoch: number;
  workflowEpoch: number;
}

export type IntegrationPushCapabilityStatus = 'active' | 'consumed' | 'revoked';

export interface IntegrationPushCapabilityRecord {
  id: string;
  /** SHA-256 digest only. The bearer secret must never be persisted. */
  secretHash: string;
  binding: IntegrationPushCapabilityBinding;
  issuedAt: string;
  expiresAt: string;
  status: IntegrationPushCapabilityStatus;
  consumedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
}

export interface IntegrationPushFence {
  tenantId: string;
  repositoryId: string;
  integrationTaskId: string;
  candidateId: string;
  revision: number;
  laneEpoch: number;
  workflowEpoch: number;
  enabled: boolean;
}

export type IntegrationPushCapabilityHostFailure =
  | 'already_exists'
  | 'not_found'
  | 'invalid_token'
  | 'already_consumed'
  | 'revoked'
  | 'expired'
  | 'fenced';

export type IntegrationPushCapabilityHostResult =
  | { ok: true; record: IntegrationPushCapabilityRecord }
  | { ok: false; reason: IntegrationPushCapabilityHostFailure };

/**
 * Persistence boundary. Implementations must make issue/consume/fence transactional
 * with the authoritative lane/workflow epochs. In particular, consumeActive must not
 * perform a read-then-write sequence outside one transaction.
 */
export interface IntegrationPushCapabilityHost {
  issueActive(record: IntegrationPushCapabilityRecord): Promise<IntegrationPushCapabilityHostResult>;
  findById(id: string): Promise<IntegrationPushCapabilityRecord | undefined>;
  consumeActive(input: {
    id: string;
    secretHash: string;
    now: string;
    binding: IntegrationPushCapabilityBinding;
  }): Promise<IntegrationPushCapabilityHostResult>;
  revoke(input: { id: string; now: string; reason: string }): Promise<IntegrationPushCapabilityHostResult>;
  /** Atomically advances/changes the fence and revokes every now-stale active capability. */
  fence(input: { fence: IntegrationPushFence; now: string; reason: string }): Promise<number>;
}

export interface IntegrationPushRequest {
  ref: string;
  oldOid: string;
  newOid: string;
  /** The gateway computes this from the repository object graph, never from runtime input. */
  isFastForward: boolean;
  operation: 'update' | 'create' | 'delete';
  laneEpoch: number;
  workflowEpoch: number;
}

export class IntegrationPushCapabilityError extends Error {
  constructor(
    public readonly code:
      | 'invalid_binding'
      | 'invalid_ref'
      | 'invalid_oid'
      | 'ttl_out_of_range'
      | 'malformed_token'
      | 'invalid_token'
      | 'not_found'
      | 'expired'
      | 'already_consumed'
      | 'revoked'
      | 'fenced'
      | 'ref_mismatch'
      | 'old_oid_mismatch'
      | 'epoch_mismatch'
      | 'delete_forbidden'
      | 'create_forbidden'
      | 'force_push_forbidden',
  ) {
    // Deliberately exclude token, ref and OIDs from errors that may be logged.
    super(`Integration push capability rejected: ${code}`);
    this.name = 'IntegrationPushCapabilityError';
  }
}

export class IntegrationPushCapabilityService {
  constructor(
    private readonly host: IntegrationPushCapabilityHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: {
    binding: IntegrationPushCapabilityBinding;
    ttlMs?: number;
  }): Promise<{ token: string; capabilityId: string; expiresAt: string }> {
    const binding = normalizeAndValidateBinding(input.binding);
    const ttlMs = input.ttlMs ?? DEFAULT_INTEGRATION_PUSH_CAPABILITY_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_INTEGRATION_PUSH_CAPABILITY_TTL_MS) {
      throw new IntegrationPushCapabilityError('ttl_out_of_range');
    }
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + ttlMs);
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const record: IntegrationPushCapabilityRecord = {
      id,
      secretHash: hashSecret(secret),
      binding,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'active',
    };
    const result = await this.host.issueActive(record);
    if (!result.ok) throw hostFailure(result.reason);
    return { token: `${TOKEN_PREFIX}.${id}.${secret}`, capabilityId: id, expiresAt: record.expiresAt };
  }

  async verify(token: string): Promise<IntegrationPushCapabilityRecord> {
    const parsed = parseToken(token);
    const record = await this.host.findById(parsed.id);
    if (!record) throw new IntegrationPushCapabilityError('not_found');
    assertSecret(record.secretHash, parsed.secret);
    if (record.status === 'consumed') throw new IntegrationPushCapabilityError('already_consumed');
    if (record.status === 'revoked') throw new IntegrationPushCapabilityError('revoked');
    if (Date.parse(record.expiresAt) <= this.now().getTime()) throw new IntegrationPushCapabilityError('expired');
    return cloneRecord(record);
  }

  async consume(token: string, request: IntegrationPushRequest): Promise<IntegrationPushCapabilityRecord> {
    const parsed = parseToken(token);
    const record = await this.host.findById(parsed.id);
    if (!record) throw new IntegrationPushCapabilityError('not_found');
    assertSecret(record.secretHash, parsed.secret);
    validatePushRequest(record.binding, request);
    const result = await this.host.consumeActive({
      id: record.id,
      secretHash: hashSecret(parsed.secret),
      now: this.now().toISOString(),
      binding: record.binding,
    });
    if (!result.ok) throw hostFailure(result.reason);
    return cloneRecord(result.record);
  }

  async revoke(tokenOrId: string, reason: string): Promise<void> {
    const tokenSupplied = tokenOrId.startsWith(`${TOKEN_PREFIX}.`);
    const id = tokenSupplied ? parseToken(tokenOrId).id : tokenOrId;
    if (!isNonEmpty(id) || !isNonEmpty(reason)) throw new IntegrationPushCapabilityError('invalid_binding');
    // Revocation by capability ID is a trusted control-plane operation. A bearer-token
    // revocation request must prove possession, otherwise a leaked ID enables denial of service.
    if (tokenSupplied) await this.verify(tokenOrId);
    const result = await this.host.revoke({ id, now: this.now().toISOString(), reason });
    if (!result.ok && result.reason !== 'already_consumed' && result.reason !== 'revoked') {
      throw hostFailure(result.reason);
    }
  }

  async fence(fence: IntegrationPushFence, reason: string): Promise<number> {
    validateFence(fence);
    if (!isNonEmpty(reason)) throw new IntegrationPushCapabilityError('invalid_binding');
    return this.host.fence({ fence: { ...fence }, now: this.now().toISOString(), reason });
  }
}

export function validatePushRequest(
  binding: IntegrationPushCapabilityBinding,
  request: IntegrationPushRequest,
): void {
  if (request.operation === 'delete' || ZERO_OID.test(request.newOid)) {
    throw new IntegrationPushCapabilityError('delete_forbidden');
  }
  if (request.operation === 'create' || ZERO_OID.test(request.oldOid)) {
    throw new IntegrationPushCapabilityError('create_forbidden');
  }
  validateExactIntegrationRef(request.ref);
  validateOid(request.oldOid);
  validateOid(request.newOid);
  if (request.ref !== binding.exactRef) throw new IntegrationPushCapabilityError('ref_mismatch');
  if (request.oldOid !== binding.expectedOldOid) throw new IntegrationPushCapabilityError('old_oid_mismatch');
  if (request.laneEpoch !== binding.laneEpoch || request.workflowEpoch !== binding.workflowEpoch) {
    throw new IntegrationPushCapabilityError('epoch_mismatch');
  }
  if (!request.isFastForward) throw new IntegrationPushCapabilityError('force_push_forbidden');
}

export function validateExactIntegrationRef(ref: string): void {
  const components = ref.split('/');
  if (
    !INTEGRATION_REF.test(ref)
    || ref.includes('..')
    || ref.includes('//')
    || ref.endsWith('/')
    || ref.endsWith('.')
    || ref.endsWith('.lock')
    || components.some((component) => component.startsWith('.'))
  ) {
    throw new IntegrationPushCapabilityError('invalid_ref');
  }
}

function normalizeAndValidateBinding(input: IntegrationPushCapabilityBinding): IntegrationPushCapabilityBinding {
  for (const value of [
    input.tenantId,
    input.repositoryId,
    input.integrationTaskId,
    input.candidateId,
    input.executionId,
  ]) {
    if (!isNonEmpty(value)) throw new IntegrationPushCapabilityError('invalid_binding');
  }
  for (const value of [input.revision, input.laneEpoch, input.workflowEpoch]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new IntegrationPushCapabilityError('invalid_binding');
  }
  validateExactIntegrationRef(input.exactRef);
  validateOid(input.expectedOldOid);
  if (ZERO_OID.test(input.expectedOldOid)) throw new IntegrationPushCapabilityError('invalid_oid');
  return { ...input };
}

function validateFence(fence: IntegrationPushFence): void {
  for (const value of [fence.tenantId, fence.repositoryId, fence.integrationTaskId, fence.candidateId]) {
    if (!isNonEmpty(value)) throw new IntegrationPushCapabilityError('invalid_binding');
  }
  for (const value of [fence.revision, fence.laneEpoch, fence.workflowEpoch]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new IntegrationPushCapabilityError('invalid_binding');
  }
}

function validateOid(oid: string): void {
  if (!OID.test(oid)) throw new IntegrationPushCapabilityError('invalid_oid');
}

function parseToken(token: string): { id: string; secret: string } {
  if (typeof token !== 'string') throw new IntegrationPushCapabilityError('malformed_token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !isNonEmpty(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? '')) {
    throw new IntegrationPushCapabilityError('malformed_token');
  }
  return { id: parts[1]!, secret: parts[2]! };
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function assertSecret(expectedHash: string, secret: string): void {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new IntegrationPushCapabilityError('invalid_token');
  }
}

function hostFailure(reason: IntegrationPushCapabilityHostFailure): IntegrationPushCapabilityError {
  if (reason === 'already_exists') return new IntegrationPushCapabilityError('fenced');
  return new IntegrationPushCapabilityError(reason);
}

function cloneRecord(record: IntegrationPushCapabilityRecord): IntegrationPushCapabilityRecord {
  return { ...record, binding: { ...record.binding } };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
