import { randomUUID } from 'node:crypto';

export const RELEASE_STATES = [
  'created', 'built', 'staging_deployed', 'verified', 'approved', 'promoting', 'completed',
  'rejected', 'revoked', 'superseded', 'partial_failed', 'needs_human',
] as const;
export type ReleaseState = typeof RELEASE_STATES[number];

export interface ReleaseAttestation {
  id: string;
  releaseId: string;
  manifestDigest: string;
  state: ReleaseState;
  operationKey: string;
  actor: string;
  recordedAt: string;
  reason?: string;
}

export interface ReleaseAttestationTiming {
  maxAttestationAgeMs?: number;
  maxFutureSkewMs?: number;
  approvalValidityMs?: number;
  now?: () => Date;
}

export const DEFAULT_MAX_ATTESTATION_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_APPROVAL_VALIDITY_MS = 24 * 60 * 60 * 1000;

const SEQUENTIAL_TRANSITIONS: Partial<Record<ReleaseState, readonly ReleaseState[]>> = {
  created: ['built'], built: ['staging_deployed'], staging_deployed: ['verified'],
  verified: ['approved'], approved: ['promoting'], promoting: ['completed'],
};
const REVOCABLE_STATES = new Set<ReleaseState>([
  'created', 'built', 'staging_deployed', 'verified', 'approved', 'promoting', 'completed',
  'rejected', 'partial_failed', 'needs_human', 'superseded',
]);
const FAILURE_STATES = new Set<ReleaseState>(['rejected', 'partial_failed', 'needs_human', 'superseded']);

function assertDigest(digest: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Attestation must bind a SHA-256 manifest digest');
}

function timestamp(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${label} must be an ISO UTC timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error(`${label} must be an ISO UTC timestamp`);
  return milliseconds;
}

export class ReleaseAttestationLog {
  private readonly entries: ReleaseAttestation[] = [];
  private readonly maxAttestationAgeMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly approvalValidityMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly releaseId: string,
    private readonly manifestDigest: string,
    timing: ReleaseAttestationTiming = {},
  ) {
    assertDigest(manifestDigest);
    this.maxAttestationAgeMs = timing.maxAttestationAgeMs ?? DEFAULT_MAX_ATTESTATION_AGE_MS;
    this.maxFutureSkewMs = timing.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
    this.approvalValidityMs = timing.approvalValidityMs ?? DEFAULT_APPROVAL_VALIDITY_MS;
    this.now = timing.now ?? (() => new Date());
  }

  list(): readonly ReleaseAttestation[] { return this.entries; }
  currentState(): ReleaseState { return this.entries.at(-1)?.state ?? 'created'; }
  boundManifestDigest(): string { return this.manifestDigest; }

  append(input: Omit<ReleaseAttestation, 'id' | 'recordedAt' | 'releaseId'> & Partial<Pick<ReleaseAttestation, 'id' | 'recordedAt'>>): ReleaseAttestation {
    assertDigest(input.manifestDigest);
    if (input.manifestDigest !== this.manifestDigest) throw new Error('Attestation manifest digest does not match immutable RC');
    if (!input.operationKey.trim()) throw new Error('Attestation operationKey is required');
    if (!input.actor.trim()) throw new Error('Attestation actor is required');
    const duplicate = this.entries.find((entry) => entry.operationKey === input.operationKey);
    if (duplicate) {
      const sameBusinessOperation = duplicate.state === input.state
        && duplicate.manifestDigest === input.manifestDigest
        && duplicate.actor === input.actor
        && duplicate.reason === input.reason
        && (input.recordedAt === undefined || duplicate.recordedAt === input.recordedAt);
      if (sameBusinessOperation) return duplicate;
      throw new Error('Attestation operationKey was already used with different content');
    }

    const recordedAt = input.recordedAt ?? this.now().toISOString();
    const recordedAtMs = timestamp(recordedAt, 'Attestation recordedAt');
    const nowMs = this.now().valueOf();
    if (recordedAtMs < nowMs - this.maxAttestationAgeMs) throw new Error('Attestation is expired');
    if (recordedAtMs > nowMs + this.maxFutureSkewMs) throw new Error('Attestation recordedAt is too far in the future');
    const latest = this.entries.at(-1);
    if (latest && recordedAtMs < timestamp(latest.recordedAt, 'Stored attestation recordedAt')) throw new Error('Attestation recordedAt is out of order');

    const current = this.currentState();
    const sequential = SEQUENTIAL_TRANSITIONS[current]?.includes(input.state) ?? false;
    const revocation = input.state === 'revoked' && REVOCABLE_STATES.has(current);
    const failure = FAILURE_STATES.has(input.state) && current !== 'completed' && current !== 'revoked';
    if (!sequential && !revocation && !failure) throw new Error(`Illegal or late RC attestation transition: ${current} -> ${input.state}`);

    const entry: ReleaseAttestation = Object.freeze({
      id: input.id ?? randomUUID(), releaseId: this.releaseId, manifestDigest: input.manifestDigest,
      state: input.state, operationKey: input.operationKey, actor: input.actor, recordedAt,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    this.entries.push(entry);
    return entry;
  }

  isPromotable(now = this.now()): boolean {
    const latest = this.entries.at(-1);
    if (latest?.state !== 'approved' || Number.isNaN(now.valueOf())) return false;
    return now.valueOf() - timestamp(latest.recordedAt, 'Approval recordedAt') <= this.approvalValidityMs;
  }
}
