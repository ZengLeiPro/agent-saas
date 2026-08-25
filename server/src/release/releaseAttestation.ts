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

const SEQUENTIAL_TRANSITIONS: Partial<Record<ReleaseState, readonly ReleaseState[]>> = {
  created: ['built'],
  built: ['staging_deployed'],
  staging_deployed: ['verified'],
  verified: ['approved'],
  approved: ['promoting'],
  promoting: ['completed'],
};
const REVOCABLE_STATES = new Set<ReleaseState>([
  'created', 'built', 'staging_deployed', 'verified', 'approved', 'promoting', 'completed',
  'rejected', 'partial_failed', 'needs_human', 'superseded',
]);
const FAILURE_STATES = new Set<ReleaseState>(['rejected', 'partial_failed', 'needs_human', 'superseded']);

function assertDigest(digest: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Attestation must bind a SHA-256 manifest digest');
}

export class ReleaseAttestationLog {
  private readonly entries: ReleaseAttestation[] = [];

  constructor(private readonly releaseId: string, private readonly manifestDigest: string) {
    assertDigest(manifestDigest);
  }

  list(): readonly ReleaseAttestation[] { return this.entries; }
  currentState(): ReleaseState { return this.entries.at(-1)?.state ?? 'created'; }

  append(input: Omit<ReleaseAttestation, 'id' | 'recordedAt' | 'releaseId'> & Partial<Pick<ReleaseAttestation, 'id' | 'recordedAt'>>): ReleaseAttestation {
    assertDigest(input.manifestDigest);
    if (input.manifestDigest !== this.manifestDigest) throw new Error('Attestation manifest digest does not match immutable RC');
    if (!input.operationKey.trim()) throw new Error('Attestation operationKey is required');
    if (!input.actor.trim()) throw new Error('Attestation actor is required');

    const duplicate = this.entries.find((entry) => entry.operationKey === input.operationKey);
    if (duplicate) {
      if (duplicate.state === input.state && duplicate.manifestDigest === input.manifestDigest && duplicate.actor === input.actor) return duplicate;
      throw new Error('Attestation operationKey was already used with different content');
    }

    const current = this.currentState();
    const sequential = SEQUENTIAL_TRANSITIONS[current]?.includes(input.state) ?? false;
    const revocation = input.state === 'revoked' && REVOCABLE_STATES.has(current);
    const failure = FAILURE_STATES.has(input.state) && current !== 'completed' && current !== 'revoked';
    if (!sequential && !revocation && !failure) {
      throw new Error(`Illegal or late RC attestation transition: ${current} -> ${input.state}`);
    }

    const entry: ReleaseAttestation = {
      id: input.id ?? randomUUID(),
      releaseId: this.releaseId,
      manifestDigest: input.manifestDigest,
      state: input.state,
      operationKey: input.operationKey,
      actor: input.actor,
      recordedAt: input.recordedAt ?? new Date().toISOString(),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    this.entries.push(Object.freeze(entry));
    return entry;
  }

  isPromotable(now = new Date()): boolean {
    const latest = this.entries.at(-1);
    return latest?.state === 'approved' && !Number.isNaN(now.valueOf());
  }
}
