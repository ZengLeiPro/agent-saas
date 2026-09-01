import { randomUUID } from 'node:crypto';

export const RELEASE_STATES = [
  'created',
  'built',
  'staging_deployed',
  'verified',
  'approved',
  'promoting',
  'awaiting_expand_confirmation',
  'completed',
  'failed_before_change',
  'rejected',
  'revoked',
  'superseded',
  'partial_failed',
  'rolled_back',
  'needs_human',
] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

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
const MAX_EXPAND_CONFIRMATION_DELAY_MS = 2 * 60 * 60 * 1000;
const MAX_CONFIRMATION_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const MAX_CONFIRMATION_FUTURE_SKEW_MS = 60 * 1000;

const SEQUENTIAL_TRANSITIONS: Partial<Record<ReleaseState, readonly ReleaseState[]>> = {
  created: ['built'],
  built: ['staging_deployed'],
  staging_deployed: ['verified'],
  verified: ['approved'],
  approved: ['promoting'],
};
const REVOCABLE_STATES = new Set<ReleaseState>([
  'created',
  'built',
  'staging_deployed',
  'verified',
  'approved',
  'promoting',
  'awaiting_expand_confirmation',
  'completed',
  'failed_before_change',
  'rejected',
  'partial_failed',
  'rolled_back',
  'needs_human',
  'superseded',
]);
// Post-mutation failure states are terminal for Promotion; only failed_before_change can re-enter approval.
// awaiting_expand_confirmation 只能由带完整绑定证据的专用确认操作进入 completed。
const FAILURE_STATES = new Set<ReleaseState>([
  'failed_before_change',
  'rejected',
  'partial_failed',
  'rolled_back',
  'needs_human',
  'superseded',
]);

function isRetryablePromotionTail(entries: readonly ReleaseAttestation[]): boolean {
  if (entries.length === 0) return false;
  let index = 0;
  while (index < entries.length) {
    if (entries[index]?.state !== 'approved') return false;
    index += 1;
    if (index === entries.length) return true;
    if (entries[index]?.state === 'promoting') {
      if (
        !promotionContext(
          entries[index]?.reason,
          entries[index]!.releaseId,
          entries[index]!.manifestDigest,
        )
      )
        return false;
      index += 1;
      if (index >= entries.length || entries[index]?.state !== 'failed_before_change') return false;
      index += 1;
    } else if (entries[index]?.state === 'failed_before_change') index += 1;
    else return false;
  }
  return true;
}

function assertDigest(digest: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error('Attestation must bind a SHA-256 manifest digest');
}

type MigrationPhase = 'none' | 'expand';

interface PromotionContext {
  releaseId: string;
  releaseSha: string;
  manifestDigest: string;
  migrationPhase: MigrationPhase;
  migrationPlanDigest: string;
  productionBeforeDigest: string;
  productionTargetDigest: string;
}

function promotionContext(
  reason: string | undefined,
  releaseId: string,
  manifestDigest: string,
): PromotionContext | null {
  if (!reason) return null;
  try {
    const value = JSON.parse(reason) as Record<string, unknown>;
    if (
      value.releaseId !== releaseId ||
      typeof value.releaseSha !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(value.releaseSha) ||
      value.manifestDigest !== manifestDigest ||
      !['none', 'expand'].includes(String(value.migrationPhase)) ||
      typeof value.migrationPlanDigest !== 'string' ||
      typeof value.productionBeforeDigest !== 'string' ||
      typeof value.productionTargetDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.migrationPlanDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.productionBeforeDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.productionTargetDigest)
    )
      return null;
    return value as unknown as PromotionContext;
  } catch {
    return null;
  }
}

function isExpandConfirmation(
  input: Pick<ReleaseAttestation, 'state' | 'operationKey' | 'reason' | 'manifestDigest'>,
  releaseId: string,
  promotion: PromotionContext | null,
  recordedAtMs: number,
  awaitingAtMs: number,
): boolean {
  if (
    input.state !== 'completed' ||
    !/^expand-confirmation:[1-9][0-9]*:[1-9][0-9]*$/u.test(input.operationKey) ||
    !input.reason ||
    promotion?.migrationPhase !== 'expand'
  ) {
    return false;
  }
  try {
    const evidence = JSON.parse(input.reason) as Record<string, unknown>;
    if (
      evidence.schemaVersion !== 1 ||
      evidence.status !== 'completed' ||
      evidence.releaseId !== releaseId ||
      evidence.manifestDigest !== input.manifestDigest ||
      evidence.apiReadyReleaseId !== releaseId ||
      evidence.apiReadyReleaseSha !== promotion.releaseSha ||
      typeof evidence.liveObservedAt !== 'string' ||
      typeof evidence.confirmedAt !== 'string' ||
      typeof evidence.operatorReason !== 'string' ||
      evidence.operatorReason.trim().length === 0 ||
      typeof evidence.confirmationEvidenceDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(evidence.confirmationEvidenceDigest) ||
      evidence.migrationPlanDigest !== promotion.migrationPlanDigest ||
      evidence.productionBeforeDigest !== promotion.productionBeforeDigest ||
      evidence.productionTargetDigest !== promotion.productionTargetDigest
    ) {
      return false;
    }
    const liveObservedAtMs = timestamp(evidence.liveObservedAt, 'Production live readback');
    const confirmedAtMs = timestamp(evidence.confirmedAt, 'Migration confirmation');
    return (
      recordedAtMs - awaitingAtMs <= MAX_EXPAND_CONFIRMATION_DELAY_MS &&
      liveObservedAtMs >= awaitingAtMs &&
      confirmedAtMs >= liveObservedAtMs &&
      recordedAtMs - liveObservedAtMs <= MAX_CONFIRMATION_EVIDENCE_AGE_MS &&
      recordedAtMs - confirmedAtMs <= MAX_CONFIRMATION_EVIDENCE_AGE_MS &&
      liveObservedAtMs <= recordedAtMs + MAX_CONFIRMATION_FUTURE_SKEW_MS &&
      confirmedAtMs <= recordedAtMs + MAX_CONFIRMATION_FUTURE_SKEW_MS
    );
  } catch {
    return false;
  }
}

function timestamp(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    throw new Error(`${label} must be an ISO UTC timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw new Error(`${label} must be an ISO UTC timestamp`);
  return milliseconds;
}

export class ReleaseAttestationLog {
  private readonly entries: ReleaseAttestation[] = [];
  private readonly maxAttestationAgeMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly approvalValidityMs: number;
  private readonly now: () => Date;
  private replayingLegacyHistory = false;

  constructor(
    private readonly releaseId: string,
    private readonly manifestDigest: string,
    timing: ReleaseAttestationTiming = {},
  ) {
    if (!/^rc-\d{8}-\d{2,}$/.test(releaseId))
      throw new Error('Attestation releaseId must use rc-YYYYMMDD-NN format');
    assertDigest(manifestDigest);
    this.maxAttestationAgeMs = timing.maxAttestationAgeMs ?? DEFAULT_MAX_ATTESTATION_AGE_MS;
    this.maxFutureSkewMs = timing.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
    this.approvalValidityMs = timing.approvalValidityMs ?? DEFAULT_APPROVAL_VALIDITY_MS;
    this.now = timing.now ?? (() => new Date());
  }

  static hydrate(
    releaseId: string,
    manifestDigest: string,
    entries: readonly ReleaseAttestation[],
    timing: ReleaseAttestationTiming = {},
  ): ReleaseAttestationLog {
    let replayNow = timing.now?.() ?? new Date();
    const log = new ReleaseAttestationLog(releaseId, manifestDigest, {
      ...timing,
      now: () => replayNow,
    });
    log.replayingLegacyHistory = true;
    try {
      for (const entry of entries) {
        if (entry.releaseId !== releaseId)
          throw new Error('Stored attestation releaseId does not match its log');
        replayNow = new Date(entry.recordedAt);
        const { releaseId: _releaseId, ...input } = entry;
        void _releaseId;
        log.append(input);
      }
    } finally {
      log.replayingLegacyHistory = false;
    }
    replayNow = timing.now?.() ?? new Date();
    return log;
  }

  list(): readonly ReleaseAttestation[] {
    return Object.freeze([...this.entries]);
  }
  currentState(): ReleaseState {
    return this.entries.at(-1)?.state ?? 'created';
  }
  boundManifestDigest(): string {
    return this.manifestDigest;
  }

  append(
    input: Omit<ReleaseAttestation, 'id' | 'recordedAt' | 'releaseId'> &
      Partial<Pick<ReleaseAttestation, 'id' | 'recordedAt'>>,
  ): ReleaseAttestation {
    assertDigest(input.manifestDigest);
    if (input.manifestDigest !== this.manifestDigest)
      throw new Error('Attestation manifest digest does not match immutable RC');
    if (!input.operationKey.trim()) throw new Error('Attestation operationKey is required');
    if (!input.actor.trim()) throw new Error('Attestation actor is required');
    const duplicate = this.entries.find((entry) => entry.operationKey === input.operationKey);
    if (duplicate) {
      const sameBusinessOperation =
        duplicate.state === input.state &&
        duplicate.manifestDigest === input.manifestDigest &&
        duplicate.actor === input.actor &&
        duplicate.reason === input.reason &&
        (input.recordedAt === undefined || duplicate.recordedAt === input.recordedAt);
      if (sameBusinessOperation) return duplicate;
      throw new Error('Attestation operationKey was already used with different content');
    }

    const recordedAt = input.recordedAt ?? this.now().toISOString();
    const recordedAtMs = timestamp(recordedAt, 'Attestation recordedAt');
    const nowMs = this.now().valueOf();
    if (recordedAtMs < nowMs - this.maxAttestationAgeMs) throw new Error('Attestation is expired');
    if (recordedAtMs > nowMs + this.maxFutureSkewMs)
      throw new Error('Attestation recordedAt is too far in the future');
    const latest = this.entries.at(-1);
    if (latest && recordedAtMs < timestamp(latest.recordedAt, 'Stored attestation recordedAt'))
      throw new Error('Attestation recordedAt is out of order');

    const current = this.currentState();
    const newPromotionContext =
      input.state === 'promoting'
        ? promotionContext(input.reason, this.releaseId, this.manifestDigest)
        : null;
    const replayingLegacyPromoting =
      this.replayingLegacyHistory &&
      input.state === 'promoting' &&
      input.reason === undefined &&
      !newPromotionContext;
    if (input.state === 'promoting' && !newPromotionContext && !replayingLegacyPromoting)
      throw new Error('Promoting attestation must bind an immutable migration phase and plan');
    const sequential = SEQUENTIAL_TRANSITIONS[current]?.includes(input.state) ?? false;
    let verifiedIndex = -1;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (this.entries[index]?.state === 'verified') {
        verifiedIndex = index;
        break;
      }
    }
    const retryTail = verifiedIndex >= 0 ? this.entries.slice(verifiedIndex + 1) : [];

    const retryAfterFailureBeforeChange =
      current === 'failed_before_change' &&
      input.state === 'approved' &&
      isRetryablePromotionTail(retryTail);
    let boundPromotionContext: PromotionContext | null = null;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry?.state === 'promoting') {
        boundPromotionContext = promotionContext(entry.reason, this.releaseId, this.manifestDigest);
        break;
      }
    }
    const promotionOutcome =
      current === 'promoting' &&
      ((input.state === 'completed' && boundPromotionContext?.migrationPhase === 'none') ||
        (input.state === 'awaiting_expand_confirmation' &&
          boundPromotionContext?.migrationPhase === 'expand'));
    const replayingLegacyCompletion =
      this.replayingLegacyHistory &&
      current === 'promoting' &&
      boundPromotionContext === null &&
      input.state === 'completed';
    const awaitingAtMs =
      current === 'awaiting_expand_confirmation' && latest !== undefined
        ? timestamp(latest.recordedAt, 'Awaiting confirmation recordedAt')
        : null;
    const expandConfirmation =
      awaitingAtMs !== null &&
      isExpandConfirmation(
        input,
        this.releaseId,
        boundPromotionContext,
        recordedAtMs,
        awaitingAtMs,
      );
    const revocation = input.state === 'revoked' && REVOCABLE_STATES.has(current);
    const failure =
      FAILURE_STATES.has(input.state) && current !== 'completed' && current !== 'revoked';
    if (
      !sequential &&
      !retryAfterFailureBeforeChange &&
      !promotionOutcome &&
      !replayingLegacyCompletion &&
      !expandConfirmation &&
      !revocation &&
      !failure
    )
      throw new Error(`Illegal or late RC attestation transition: ${current} -> ${input.state}`);

    const entry: ReleaseAttestation = Object.freeze({
      id: input.id ?? randomUUID(),
      releaseId: this.releaseId,
      manifestDigest: input.manifestDigest,
      state: input.state,
      operationKey: input.operationKey,
      actor: input.actor,
      recordedAt,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    this.entries.push(entry);
    return entry;
  }

  isPromotable(now = this.now()): boolean {
    const latest = this.entries.at(-1);
    if (latest?.state !== 'approved' || Number.isNaN(now.valueOf())) return false;
    return (
      now.valueOf() - timestamp(latest.recordedAt, 'Approval recordedAt') <= this.approvalValidityMs
    );
  }
}
